// Fallback path for non-Opus sources (e.g. AAC/M4A itags).
//
// Uses in-process libav bindings (e.g. `beamcoder`) rather than spawning an
// ffmpeg subprocess per track — avoids process-spawn overhead and keeps
// memory bounded under MAX_CONCURRENT_STREAMS.
//
// TODO: wire up `beamcoder` decode(AAC) -> resample(48kHz stereo) ->
// encode(libopus) pipeline here. Stubbed until a non-Opus source is
// actually hit in practice — itag 251/250/249 (Opus/WebM) cover the vast
// majority of audio-only YouTube streams.
export async function transcodeToOpus(sourceStream) {
  throw new Error('Non-Opus source encountered — transcode path not yet implemented.');
}
