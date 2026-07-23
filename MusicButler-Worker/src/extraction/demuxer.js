import prism from 'prism-media';

// Demux Opus packets straight out of a WebM container. No re-encode —
// this is the cheap path used when the source format is already Opus.
export function demuxOpusStream(readableWebmStream) {
  const demuxer = new prism.opus.WebmDemuxer();
  return readableWebmStream.pipe(demuxer); // emits raw Opus packets ('data' events, Buffer per packet)
}
