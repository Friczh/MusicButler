import { PassThrough } from 'node:stream';
import { PreBufferedOpusStream } from '../src/audio/preBuffer.js';

const source = new PassThrough();
const buffered = new PreBufferedOpusStream(source, { startFrames: 3 });

const received = [];
buffered.on('data', (chunk) => received.push(chunk.toString()));

let ended = false;
buffered.on('end', () => { ended = true; });

source.write(Buffer.from('1'));
await new Promise(r => setTimeout(r, 20));
console.log('after 1 chunk, received:', received.length, '(expect 0, below threshold)');

source.write(Buffer.from('2'));
source.write(Buffer.from('3'));
await new Promise(r => setTimeout(r, 20));
console.log('after 3 chunks, received:', received.length, '(expect 3, threshold met, flushed)');

source.write(Buffer.from('4'));
await new Promise(r => setTimeout(r, 20));
console.log('after 4th chunk (live), received:', received.length, '(expect 4)');

source.end();
await new Promise(r => setTimeout(r, 20));
console.log('ended:', ended, '(expect true)');
console.log('sequence:', received.join(''));

const pass = received.length === 4 && received.join('') === '1234' && ended === true;
console.log(pass ? 'PASS: pre-buffer withholds then streams correctly' : 'FAIL');
process.exit(pass ? 0 : 1);
