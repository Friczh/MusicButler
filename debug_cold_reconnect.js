const { buildSabrAudioStream } = require('./src/lib/sabr');
const { CompositeBuffer, UmpWriter } = require('googlevideo/ump');
const {
  MediaHeader, FormatInitializationMetadata, NextRequestPolicy,
  VideoPlaybackAbrRequest, UMPPartId,
} = require('googlevideo/protos');
const { concatenateChunks } = require('googlevideo/utils');
const fs = require('node:fs');

function part(partType, partData) { return { partType, partData }; }
function mediaHeaderPart(headerId, sequenceNumber, startMs, durationMs, startRange, contentLength, isInitSeg, format) {
  return part(UMPPartId.MEDIA_HEADER, MediaHeader.encode({
    headerId, videoId: '', itag: format.itag, lmt: format.lastModified,
    startRange: startRange.toString(), compressionAlgorithm: 0, isInitSeg,
    sequenceNumber, bitrateBps: format.bitrate.toString(), startMs: startMs.toString(),
    durationMs: durationMs.toString(), formatId: format, contentLength: contentLength.toString(),
    timeRange: { startTicks: startMs.toString(), durationTicks: durationMs.toString(), timescale: 1000 },
  }).finish());
}
function mediaPart(headerId, bytes) { return part(UMPPartId.MEDIA, new Uint8Array([headerId, ...bytes])); }
function mediaEndPart(headerId) { return part(UMPPartId.MEDIA_END, new Uint8Array([headerId])); }

const fileBuffer = fs.readFileSync('test/fixtures/tone.webm');
const audioFormat = { itag: 251, lastModified: '1700000000', contentLength: fileBuffer.length, mimeType: 'audio/webm; codecs="opus"', bitrate: 64000, approxDurationMs: 1000 };
const VIDEO_FORMAT = { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4337000, lastModified: '1700000000', height: 1080, approxDurationMs: 1000 };
const initSize = 1500, segmentSize = 1800;
const initBytes = fileBuffer.subarray(0, initSize);
const restBytes = fileBuffer.subarray(initSize);
const mediaSegments = [];
for (let i = 0; i < restBytes.length; i += segmentSize) mediaSegments.push(restBytes.subarray(i, i + segmentSize));
const segDurationMs = Math.round(1000 / mediaSegments.length);

// Deliver init + segment0 + segment1 successfully (real progress), THEN stall.
let nextSegmentIndex = 1;
let deliveredCount = 0;
let stalledOnce = false;

const fetchFn = async (_url, options) => {
  const bodyBytes = new Uint8Array(options.body instanceof ArrayBuffer ? options.body : await new Response(options.body).arrayBuffer());
  const req = VideoPlaybackAbrRequest.decode(bodyBytes);
  const playerTimeMs = parseInt(req.clientAbrState?.playerTimeMs || '0');
  const parts = [];
  parts.push(part(UMPPartId.NEXT_REQUEST_POLICY, NextRequestPolicy.encode({
    targetAudioReadaheadMs: 15000, targetVideoReadaheadMs: 15000, backoffTimeMs: 0,
    playbackCookie: { resolution: 0, field2: 0, videoFmt: VIDEO_FORMAT, audioFmt: audioFormat }, videoId: '',
  }).finish()));

  if (playerTimeMs === 0) {
    parts.push(part(UMPPartId.FORMAT_INITIALIZATION_METADATA, FormatInitializationMetadata.encode({
      formatId: audioFormat, durationUnits: '1000', durationTimescale: '1000', endSegmentNumber: String(mediaSegments.length),
      mimeType: audioFormat.mimeType, endTimeMs: '1000', videoId: '',
    }).finish()));
    parts.push(part(UMPPartId.FORMAT_INITIALIZATION_METADATA, FormatInitializationMetadata.encode({
      formatId: VIDEO_FORMAT, durationUnits: '1000', durationTimescale: '1000', endSegmentNumber: '0',
      mimeType: VIDEO_FORMAT.mimeType, endTimeMs: '1000', videoId: '',
    }).finish()));
    parts.push(mediaHeaderPart(0, 0, 0, 0, 0, initBytes.length, true, audioFormat));
    parts.push(mediaPart(0, initBytes));
    parts.push(mediaEndPart(0));
    parts.push(mediaHeaderPart(1, 1, 0, segDurationMs, initSize, mediaSegments[0].length, false, audioFormat));
    parts.push(mediaPart(1, mediaSegments[0]));
    parts.push(mediaEndPart(1));
    deliveredCount++;
  } else if (nextSegmentIndex < 2 && !stalledOnce) {
    // Deliver segment[1] normally first (genuine forward progress)
    const seg = mediaSegments[nextSegmentIndex];
    const headerId = nextSegmentIndex + 1;
    const startMs = nextSegmentIndex * segDurationMs;
    const startRange = initSize + mediaSegments.slice(0, nextSegmentIndex).reduce((s, m) => s + m.length, 0);
    parts.push(mediaHeaderPart(headerId, nextSegmentIndex + 1, startMs, segDurationMs, startRange, seg.length, false, audioFormat));
    parts.push(mediaPart(headerId, seg));
    parts.push(mediaEndPart(headerId));
    nextSegmentIndex++;
    deliveredCount++;
  } else if (!stalledOnce) {
    stalledOnce = true; // now stall
  } else if (nextSegmentIndex < mediaSegments.length) {
    const seg = mediaSegments[nextSegmentIndex];
    const headerId = nextSegmentIndex + 1;
    const startMs = nextSegmentIndex * segDurationMs;
    const startRange = initSize + mediaSegments.slice(0, nextSegmentIndex).reduce((s, m) => s + m.length, 0);
    parts.push(mediaHeaderPart(headerId, nextSegmentIndex + 1, startMs, segDurationMs, startRange, seg.length, false, audioFormat));
    parts.push(mediaPart(headerId, seg));
    parts.push(mediaEndPart(headerId));
    nextSegmentIndex++;
  }

  const buffer = new CompositeBuffer();
  const writer = new UmpWriter(buffer);
  for (const p of parts) writer.write(p.partType, p.partData);
  return new Response(concatenateChunks(buffer.chunks), { status: 200, headers: { 'Content-Type': 'application/vnd.yt-ump' } });
};

const info = {
  streaming_data: { server_abr_streaming_url: 'https://test.invalid/x', adaptive_formats: [VIDEO_FORMAT, audioFormat] },
  player_config: { media_common_config: { media_ustreamer_request_config: { video_playback_ustreamer_config: 'abc' } } },
};
const MOCK_SESSION = { session: { player: { decipher: (url) => url } } };
const CLIENT_INFO = { clientName: 1, clientVersion: '2.20240101.00.00' };

(async () => {
  global.fetch = fetchFn;
  const { audioStream } = await buildSabrAudioStream(info, MOCK_SESSION, CLIENT_INFO, 'abc', {
    refetchInfo: async () => info, stallDetectionMs: 1,
  });
  const reader = audioStream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  const reassembled = Buffer.concat(chunks);
  console.log('reassembled length:', reassembled.length, 'expected:', fileBuffer.length);
  console.log('bytes equal:', reassembled.equals(fileBuffer));
  // Count EBML magic occurrences (1a45dfa3) -- more than 1 = duplicate header
  const magic = Buffer.from([0x1a,0x45,0xdf,0xa3]);
  let count = 0, idx = 0;
  while ((idx = reassembled.indexOf(magic, idx)) !== -1) { count++; idx++; }
  console.log('EBML magic occurrences:', count);
})().catch(e => console.error('ERR', e));
