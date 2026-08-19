'use strict';

const { PassThrough } = require('node:stream');
const prism = require('prism-media');

/**
 * Wires a raw webm/opus byte stream through prism-media's WebmDemuxer into
 * a stall-buffered, object-mode stream of raw Opus frames -- the shape
 * @discordjs/voice's StreamType.Opus expects.
 *
 * Exists as its own function because .pipe() doesn't forward 'error'
 * events between stages -- an unhandled error in the demuxer would
 * otherwise crash the whole process. This wires an explicit error
 * listener on every stage instead.
 *
 * @param {import('node:stream').Readable} byteStream raw webm/opus bytes
 * @param {object} [opts]
 * @param {number} [opts.highWaterMark] object-mode buffer depth (frames, not bytes)
 * @param {(err: Error, ctx: { firstBytes: Buffer | null }) => void} [opts.onError]
 *   `firstBytes` is up to the first 32 bytes received before failure, or
 *   null -- useful for diagnosing e.g. a missing EBML magic-byte header.
 * @returns {import('node:stream').PassThrough} object-mode stream of raw
 *   Opus frames, ready for createAudioResource(stream, { inputType: StreamType.Opus }).
 */
function buildOpusPipeline(byteStream, { highWaterMark = 10, onError } = {}) {
  const stage2 = new PassThrough({ objectMode: true, highWaterMark });

  // Just an extra listener on byteStream's own 'data' event -- doesn't
  // add a buffering stage, just observes for diagnostics.
  let firstBytesSeen = null;
  byteStream.on('data', (chunk) => {
    if (firstBytesSeen === null) firstBytesSeen = chunk.subarray(0, 32);
  });

  const demuxer = new prism.opus.WebmDemuxer();

  let handled = false;
  const handleError = (err) => {
    if (handled) return;
    handled = true;
    onError?.(err, { firstBytes: firstBytesSeen });
    if (!stage2.destroyed) stage2.destroy(err);
  };
  byteStream.on('error', handleError);
  demuxer.on('error', handleError);
  // Guarantees 'error' is never unhandled on stage2, regardless of when
  // (or whether) a downstream consumer attaches its own listener.
  stage2.on('error', () => {});

  byteStream.pipe(demuxer).pipe(stage2);
  return stage2;
}

/**
 * Wires a raw, non-WebM/Opus byte stream (e.g. fMP4/AAC, which SABR can
 * hand back when a video has no Opus-coded format) through an FFmpeg
 * decode + Opus re-encode, into the same shape buildOpusPipeline()
 * produces. Needed because WebmDemuxer only demuxes existing Opus out of
 * WebM -- it has no decoder for AAC.
 *
 * Chain: FFmpeg -> raw PCM -> prism.opus.Encoder (not FFmpeg's own Opus
 * muxer output, which is Ogg-wrapped and prism-media has no matching
 * demuxer for). Requires ffmpeg-static (auto-detected by prism.FFmpeg)
 * and opusscript (pure-JS, no native build step needed).
 *
 * @param {import('node:stream').Readable} byteStream raw compressed audio bytes
 * @param {object} [opts]
 * @param {number} [opts.highWaterMark] object-mode buffer depth (frames, not bytes)
 * @param {(err: Error, ctx: { firstBytes: Buffer | null }) => void} [opts.onError]
 *   Same contract as buildOpusPipeline()'s onError.
 * @returns {import('node:stream').PassThrough} object-mode stream of raw Opus frames.
 */
function buildTranscodedOpusPipeline(byteStream, { highWaterMark = 10, onError } = {}) {
  const stage2 = new PassThrough({ objectMode: true, highWaterMark });

  let firstBytesSeen = null;
  byteStream.on('data', (chunk) => {
    if (firstBytesSeen === null) firstBytesSeen = chunk.subarray(0, 32);
  });

  let handled = false;
  const handleError = (err) => {
    if (handled) return;
    handled = true;
    onError?.(err, { firstBytes: firstBytesSeen });
    if (!stage2.destroyed) stage2.destroy(err);
  };

  let ffmpeg;
  let encoder;
  let stderrTail = '';
  try {
    // No -f/-i on input -- FFmpeg probes the container from piped bytes.
    ffmpeg = new prism.FFmpeg({
      args: [
        '-analyzeduration', '0',
        '-loglevel', 'warning',
        '-ar', '48000',
        '-ac', '2',
        '-f', 's16le',
      ],
    });
    // FFmpeg's decode diagnostics only go to stderr, never surfaced by
    // prism-media's wrapper -- captured here so the zero-frame check
    // below can report why, not just "no output".
    ffmpeg.process?.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  } catch (err) {
    // Sync construction failure (e.g. ffmpeg-static binary missing) --
    // deferred via queueMicrotask so callers get one consistent failure
    // path (onError / the returned stream's 'error' event) regardless of
    // sync vs async.
    queueMicrotask(() => handleError(err));
    return stage2;
  }

  // FFmpeg doesn't propagate a bad exit code as a stream error --
  // corrupt input just ends the stream cleanly with zero bytes. Treated
  // as an explicit error here instead of silently playing nothing.
  let frameCount = 0;
  encoder.on('data', () => { frameCount++; });
  encoder.on('end', () => {
    if (frameCount === 0 && !handled) {
      handleError(new Error(
        `FFmpeg produced no audio output (0 frames) -- likely corrupt, unsupported, or ` +
        `DRM-protected input. ffmpeg stderr: ${stderrTail.trim() || '(empty)'}`
      ));
    }
  });

  byteStream.on('error', handleError);
  ffmpeg.on('error', handleError);
  encoder.on('error', handleError);
  // See buildOpusPipeline() above for why this no-op listener is required.
  stage2.on('error', () => {});

  byteStream.pipe(ffmpeg).pipe(encoder).pipe(stage2);
  return stage2;
}

module.exports = { buildOpusPipeline, buildTranscodedOpusPipeline };
