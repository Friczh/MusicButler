'use strict';

// SABR fallback path — youtubei.js has no UMP/SABR client; that lives in
// `googlevideo` (SabrStream). Both are ESM-only; CJS require() works fine
// on Node 20.19+/22.12+.
const { SabrStream } = require('googlevideo/sabr-stream');
const { buildSabrFormat, EnabledTrackTypes } = require('googlevideo/utils');
const { log } = require('./log');

// Never log a full PO token. Fingerprint lets us confirm session vs video
// tokens actually differ, and whether a "refresh" really changed anything.
function tokenFingerprint(token) {
  if (!token) return '<none>';
  return `len=${token.length} tail=…${token.slice(-6)}`;
}

const PROTECTION_STATUS_LABELS = {
  0: 'OK',
  1: 'RECHECK_REQUIRED',
  2: 'ATTESTATION_PENDING',
  3: 'ATTESTATION_REQUIRED',
};

// SabrStream's internal retry hits the same doomed request up to 10x
// (~59s) before a real reload/attestation failure ever reaches our own
// reconnect logic below. Lowered so reconnect kicks in within seconds.
const SABR_MAX_RETRIES = 3;

// Errors treated as recoverable (reconnect instead of failing the track).
// Confirmed by auditing every throw site in googlevideo@4.0.4's
// SabrStream.js. Covers: server-requested reload, attestation stuck
// pending/required (often a stale video-bound PO token), a stall after
// 5 no-progress checks, and a response that parsed to zero UMP parts.
const ATTESTATION_ERROR_MESSAGE = 'Cannot proceed with stream: attestation required';

const RECOVERABLE_SABR_ERROR_MESSAGES = new Set([
  'Player response reload requested by server',
  'No media parts or protocol updates received from server.',
  ATTESTATION_ERROR_MESSAGE,
  'Stream stalled 5 times, aborting',
  'No valid parts received from server.',
]);

// Caps reconnect attempts so a condition that keeps recurring (e.g.
// attestation failing again on every fresh session) can't loop forever.
const MAX_SABR_RECONNECT_ATTEMPTS = 5;

/**
 * Picks the SABR audio format to request. If `preferredItag` (the itag
 * direct-download already chose) is present, use it exactly — keeps both
 * paths on the identical container/codec instead of possibly mismatching
 * (e.g. SABR falling back to non-WebM, which the WebM demuxer can't read).
 * Otherwise: best-bitrate Opus, or best-bitrate of any codec if no Opus.
 */
function chooseAudioFormat(formats, preferredItag) {
  if (preferredItag) {
    const exact = formats.find((f) => f.itag === preferredItag);
    if (exact) return exact;
  }
  const opusOnly = formats.filter((f) => f.mimeType?.includes('opus'));
  const pool = opusOnly.length ? opusOnly : formats;
  return pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

/**
 * Builds a raw webm/opus (or other codec) audio ReadableStream via SABR,
 * for a track whose direct-URL download failed.
 *
 * @param {import('youtubei.js').VideoInfo | import('youtubei.js').TrackInfo} info
 * @param {import('youtubei.js').Innertube} session
 * @param {{ clientName: number, clientVersion: string }} clientInfo
 * @param {string} poToken video-ID-bound token, not the session one.
 * @param {{ preferredItag?: number, refetchInfo?: Function, refetchPoToken?: Function, stallDetectionMs?: number, onReconnectStart?: Function, onReconnectEnd?: Function }} [opts]
 *   refetchInfo/refetchPoToken: called on a recoverable mid-stream failure
 *   to re-fetch info/token and reconnect seamlessly instead of erroring.
 *   refetchPoToken must bypass bgutil-rust's content_binding->po_token
 *   cache (potProvider.getPoToken's bypassCache option) -- without that,
 *   this just returns the same already-rejected token and the
 *   attestation-pending state never actually resolves.
 * @returns {Promise<{ audioStream: ReadableStream<Uint8Array>, format: object, abort: () => void }>}
 *   `format.mimeType` tells the caller whether to demux as-is (Opus) or
 *   transcode (anything else). `abort` must be called on skip/failure —
 *   cancelling the wrapped Node stream alone does not stop the fetch loop.
 */
/**
 * Derives per-attempt SABR params (deciphered URL, ustreamer config,
 * format list) from `info`. Split out so a reconnect can re-derive from
 * fresh info without duplicating validation. Sync field checks run before
 * the one async step (decipher) so bad input fails fast.
 * @private
 */
async function deriveSabrParams(info, session) {
  const streamingData = info.streaming_data;
  const rawServerAbrStreamingUrl = streamingData?.server_abr_streaming_url;
  if (!rawServerAbrStreamingUrl) {
    throw new Error(
      'buildSabrAudioStream: no server_abr_streaming_url on streaming_data -- not a SABR-eligible response, fallback does not apply here'
    );
  }

  // Sibling field on info.player_config, not nested in streaming_data.
  // Same path for both regular YouTube and YT Music (shared MediaInfo mixin).
  const videoPlaybackUstreamerConfig =
    info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  if (!videoPlaybackUstreamerConfig) {
    throw new Error(
      'buildSabrAudioStream: no video_playback_ustreamer_config on info.player_config -- cannot build a valid SABR request'
    );
  }

  // Needs both audio AND video candidates -- SabrStream#selectFormats()
  // throws if either track type is empty, even though only audio is used.
  const sabrFormats = (streamingData.adaptive_formats || []).map(buildSabrFormat);
  if (!sabrFormats.some((f) => f.mimeType?.includes('video'))) {
    throw new Error(
      'buildSabrAudioStream: no video-type format present in adaptive_formats -- SabrStream requires at least one video candidate even for audio-only playback, cannot proceed'
    );
  }

  // Must decipher the n-sig cipher before use, same as any adaptive_formats
  // URL, or the CDN rejects the request with 403.
  const serverAbrStreamingUrl = await session.session.player.decipher(rawServerAbrStreamingUrl);

  return { serverAbrStreamingUrl, videoPlaybackUstreamerConfig, sabrFormats };
}

/**
 * Starts one SABR attempt (fresh, or resumed from a captured `state`).
 * Wires up reload-request capture, since YouTube can invalidate the
 * session mid-stream via RELOAD_PLAYER_RESPONSE.
 * @private
 */
async function startSabrAttempt(params, clientInfo, poToken, preferredItag, resumeState, stallDetectionMs, refetchPoToken, onPoTokenRefreshed) {
  const attemptStartedAt = Date.now();
  log.debug(
    'sabr',
    `starting SabrStream attempt -- poToken ${tokenFingerprint(poToken)}, ` +
    `resumed=${!!resumeState}, preferredItag=${preferredItag ?? '<none>'}`
  );
  const stream = new SabrStream({
    serverAbrStreamingUrl: params.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: params.videoPlaybackUstreamerConfig,
    clientInfo,
    poToken,
    formats: params.sabrFormats,
  });

  // Must capture state synchronously inside the event listener -- the
  // library resets it right after emitting, before our catch block runs.
  let reloadState = null;
  let tokenRefreshInFlight = false;
  stream.on('reloadPlayerResponse', () => {
    log.debug('sabr', `reloadPlayerResponse event received (${Date.now() - attemptStartedAt}ms into this attempt)`);
    captureReloadState();
  });
  // Attestation pending/required has no dedicated failure event -- only
  // this status update -- so state is captured proactively here too.
  // Logged at every status (not just >=2) so a capture shows the full
  // transition sequence (e.g. resolves on its own vs. stays stuck).
  stream.on('streamProtectionStatusUpdate', (status) => {
    const label = PROTECTION_STATUS_LABELS[status?.status] ?? `UNKNOWN(${status?.status})`;
    log.debug(
      'sabr',
      `streamProtectionStatusUpdate: status=${status?.status} (${label}), ` +
      `${Date.now() - attemptStartedAt}ms into this attempt`
    );
    if (status?.status >= 2) {
      log.error(
        'sabr',
        `attestation status ${label} on this attempt -- poToken ${tokenFingerprint(poToken)}`
      );
      captureReloadState();
      // Try setPoToken() on the live stream before SABR_MAX_RETRIES exhausts
      // and the outer reconnect loop tears the whole attempt down. Cheap:
      // reuses the existing connection instead of a full reconnect. Guarded
      // to fire once per attempt -- repeated status events while one
      // refresh is already in flight shouldn't stack overlapping mints.
      if (refetchPoToken && !tokenRefreshInFlight) {
        tokenRefreshInFlight = true;
        // refetchPoToken must itself bypass the cache (see JSDoc above) --
        // this call has no cache-busting logic of its own.
        refetchPoToken()
          .then((freshToken) => {
            log.debug(
              'sabr',
              `attestation ${label} -- re-minted PO token ${tokenFingerprint(poToken)} -> ` +
              `${tokenFingerprint(freshToken)}, calling setPoToken() before retries exhaust`
            );
            stream.setPoToken(freshToken);
            onPoTokenRefreshed?.(freshToken);
          })
          .catch((err) => {
            log.error('sabr', `attestation ${label} -- setPoToken() refresh attempt failed: ${err.message}`);
          });
      }
    }
  });
  function captureReloadState() {
    try {
      reloadState = stream.getState();
    } catch (err) {
      // Nothing to resume from if the event fired before the first segment.
      reloadState = null;
    }
  }

  let selectedFormats;
  let audioStream;
  try {
    // Don't pass preferWebM/MP4/H264 as top-level start() options -- they
    // constrain BOTH audio and video candidates, and the video pick (which
    // gets discarded anyway) can fail to match, breaking selection entirely.
    ({ audioStream, selectedFormats } = await stream.start({
      audioFormat: (formats) => chooseAudioFormat(formats, preferredItag),
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
      maxRetries: SABR_MAX_RETRIES,
      state: resumeState,
      stallDetectionMs,
    }));
  } catch (err) {
    throw new Error(`buildSabrAudioStream: SabrStream.start() failed during format selection: ${err.message}`);
  }

  if (!selectedFormats?.audioFormat) {
    throw new Error('buildSabrAudioStream: SabrStream selected no audio format');
  }

  log.debug(
    'sabr',
    `attempt started successfully in ${Date.now() - attemptStartedAt}ms -- ` +
    `selected itag ${selectedFormats.audioFormat.itag}, mimeType ${selectedFormats.audioFormat.mimeType}`
  );

  return {
    stream,
    audioStream,
    selectedFormats,
    getReloadState: () => reloadState,
  };
}

async function buildSabrAudioStream(info, session, clientInfo, poToken, { preferredItag, refetchInfo, refetchPoToken, stallDetectionMs, onReconnectStart, onReconnectEnd } = {}) {
  const trackStartedAt = Date.now();
  const params = await deriveSabrParams(info, session);
  let currentPoToken = poToken;
  // True once a proactive setPoToken() refresh has landed for the attempt
  // currently in flight -- lets the outer reconnect below skip a redundant
  // refetchPoToken() call if the attempt already got a fresh one this way.
  let poTokenRefreshedThisAttempt = false;
  const onPoTokenRefreshed = (freshToken) => {
    currentPoToken = freshToken;
    poTokenRefreshedThisAttempt = true;
  };
  let attempt = await startSabrAttempt(
    params, clientInfo, poToken, preferredItag, undefined, stallDetectionMs, refetchPoToken, onPoTokenRefreshed
  );
  // Lets reconnect logging show the gap between loop iterations.
  let lastReconnectAt = trackStartedAt;

  // Whether Opus or not is the caller's decision (routes to a different
  // pipeline in player.js) -- this just returns the format either way.
  //
  // Fixed for the whole track: every reconnect re-requests this exact
  // itag, since resumed state only matches against the same format key.
  const audioFormat = attempt.selectedFormats.audioFormat;

  let currentReader = attempt.audioStream.getReader();
  let aborted = false;
  let reconnectAttempts = 0;
  // True from the moment a reconnect starts until its first real chunk
  // arrives -- lets onReconnectEnd fire on "has data", not just "started".
  let awaitingFirstChunkAfterReconnect = false;
  // True once any chunk has ever been delivered for this track. Tells
  // apart "never played at all" from "played fine, then started looping".
  let sawFirstChunk = false;

  // start() above doesn't throw on async failures -- it kicks off the
  // background fetch loop and returns immediately. Failures surface here,
  // through reader.read() rejecting.
  //
  // Recoverable failures are handled by pumping into this SAME outer
  // stream after a reconnect, so player.js's error handling never sees
  // them -- from its side, the track just kept playing.
  const relay = new ReadableStream({
    async pull(controller) {
      for (;;) {
        let result;
        try {
          result = await currentReader.read();
        } catch (err) {
          if (aborted) {
            controller.close();
            return;
          }
          // Don't leave a paused AudioPlayer stuck if we're about to hard-error.
          const clearReconnectFlag = () => {
            if (awaitingFirstChunkAfterReconnect) {
              awaitingFirstChunkAfterReconnect = false;
              onReconnectEnd?.();
            }
          };
          if (!RECOVERABLE_SABR_ERROR_MESSAGES.has(err.message) || !refetchInfo) {
            log.error(
              'sabr',
              `non-recoverable SABR failure (${err.message}) -- ` +
              `${Date.now() - trackStartedAt}ms since track start, ${reconnectAttempts} prior reconnects, ` +
              `refetchInfo=${!!refetchInfo}`
            );
            clearReconnectFlag();
            controller.error(err);
            return;
          }
          const now = Date.now();
          const sinceLastReconnect = now - lastReconnectAt;
          const sinceTrackStart = now - trackStartedAt;
          if (reconnectAttempts >= MAX_SABR_RECONNECT_ATTEMPTS) {
            log.error(
              'sabr',
              `giving up after ${MAX_SABR_RECONNECT_ATTEMPTS} reconnect attempts -- ` +
              `${sinceTrackStart}ms since track start, last reconnect ${sinceLastReconnect}ms ago, ` +
              `everPlayedAnyAudio=${sawFirstChunk}, last error: ${err.message}`
            );
            clearReconnectFlag();
            controller.error(
              new Error(`buildSabrAudioStream: gave up after ${MAX_SABR_RECONNECT_ATTEMPTS} reconnect attempts (last error: ${err.message})`)
            );
            return;
          }
          reconnectAttempts++;
          lastReconnectAt = now;
          const reloadState = attempt.getReloadState();
          console.warn(
            `buildSabrAudioStream: recoverable SABR failure mid-stream (${err.message}) -- ` +
            `reconnecting (attempt ${reconnectAttempts}/${MAX_SABR_RECONNECT_ATTEMPTS}), ` +
            `${sinceTrackStart}ms since track start, ${sinceLastReconnect}ms since last reconnect` +
            `${reloadState ? ' with resumed playback position' : ' from a cold start (no resumable state captured)'}` +
            `${refetchPoToken ? ', re-minting PO token' : ''}`
          );
          onReconnectStart?.();
          awaitingFirstChunkAfterReconnect = true;
          try {
            if (refetchPoToken) {
              if (poTokenRefreshedThisAttempt) {
                log.debug(
                  'sabr',
                  `reconnecting -- reusing ${tokenFingerprint(currentPoToken)} already refreshed via ` +
                  `setPoToken() mid-attempt, skipping redundant refetchPoToken()`
                );
              } else {
                const previousToken = currentPoToken;
                // refetchPoToken must bypass bgutil-rust's cache itself
                // (see JSDoc on buildSabrAudioStream) -- nothing to bust
                // here.
                currentPoToken = await refetchPoToken();
                log.debug(
                  'sabr',
                  `re-minted PO token: ${tokenFingerprint(previousToken)} -> ${tokenFingerprint(currentPoToken)}` +
                  `${previousToken === currentPoToken ? ' (WARNING: identical to previous token -- refresh may not be working)' : ''}`
                );
              }
            }
            poTokenRefreshedThisAttempt = false;
            const freshInfo = await refetchInfo();
            const freshParams = await deriveSabrParams(freshInfo, session);
            attempt = await startSabrAttempt(
              freshParams,
              clientInfo,
              currentPoToken,
              audioFormat.itag,
              reloadState || undefined,
              stallDetectionMs,
              refetchPoToken,
              onPoTokenRefreshed
            );
            currentReader = attempt.audioStream.getReader();
            continue; // retry the read against the newly reconnected stream
          } catch (reconnectErr) {
            log.error(
              'sabr',
              `reconnect attempt ${reconnectAttempts}/${MAX_SABR_RECONNECT_ATTEMPTS} itself failed: ${reconnectErr.message}`
            );
            clearReconnectFlag();
            controller.error(
              new Error(`buildSabrAudioStream: reload reconnect failed: ${reconnectErr.message}`)
            );
            return;
          }
        }
        if (result.done) {
          controller.close();
          return;
        }
        if (awaitingFirstChunkAfterReconnect) {
          awaitingFirstChunkAfterReconnect = false;
          onReconnectEnd?.();
        }
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          log.debug(
            'sabr',
            `first real media chunk received ${Date.now() - trackStartedAt}ms after track start ` +
            `(${reconnectAttempts} reconnects so far) -- attestation/format selection confirmed resolved`
          );
        }
        if (process.env.SABR_DEBUG_ENQUEUE) console.error('[ENQUEUE]', result.value.length, 'bytes, first4=', Buffer.from(result.value.slice(0,4)).toString('hex'));
        controller.enqueue(result.value);
        return;
      }
    },
    cancel() {
      aborted = true;
      attempt.stream.abort();
    },
  });

  // `abort` targets whichever SabrStream instance is currently live
  // (reassigned on each reconnect). Required -- cancelling the Node stream
  // this gets wrapped into does NOT stop the background fetch loop itself.
  return {
    audioStream: relay,
    format: audioFormat,
    abort: () => {
      aborted = true;
      attempt.stream.abort();
    },
  };
}

module.exports = { buildSabrAudioStream, chooseAudioFormat };
