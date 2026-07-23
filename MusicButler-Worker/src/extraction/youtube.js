import { Readable } from 'node:stream';
import { Innertube } from 'youtubei.js';
import { config } from '../config.js';
import { getPoToken } from '../pot/potClient.js';
import { selectAudioFormat } from './formatSelector.js';
import { demuxOpusStream } from './demuxer.js';
import { transcodeToOpus } from './transcode.js';

let innertube;

async function getClient() {
  if (!innertube) {
    innertube = await Innertube.create({
      cookie: config.youtubeCookies || undefined,
    });
  }
  return innertube;
}

// Returns a Node Readable stream of raw Opus packets (Buffer per packet).
export async function getOpusPacketStream(videoId) {
  const yt = await getClient();
  const info = await yt.getInfo(videoId);

  const poToken = await getPoToken(videoId);
  const { format, isOpus } = selectAudioFormat(info);
  if (!format) throw new Error(`No audio format available for ${videoId}`);

  // info.download() returns a Web ReadableStream, not a Node Readable —
  // prism-media (used by the demuxer) expects Node streams, so convert.
  const webStream = await info.download({
    type: 'audio',
    codec: isOpus ? 'opus' : undefined,
    itag: format.itag,
    po_token: poToken,
  });
  const nodeStream = Readable.fromWeb(webStream);

  if (isOpus) {
    return demuxOpusStream(nodeStream);
  }
  return transcodeToOpus(nodeStream);
}
