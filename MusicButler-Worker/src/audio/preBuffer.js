import { Readable } from 'node:stream';

export class PreBufferedOpusStream extends Readable {
  constructor(sourceStream, { startFrames = 25 } = {}) { // 25 frames * 20ms = 500ms
    super();
    this.queue = [];
    this.sourceEnded = false;
    this.started = false;
    this.startFrames = startFrames;

    sourceStream.on('data', (chunk) => {
      this.queue.push(chunk);
      if (!this.started && this.queue.length >= this.startFrames) this.started = true;
      this._maybePush();
    });
    sourceStream.on('end', () => {
      this.sourceEnded = true;
      this._maybePush();
    });
    sourceStream.on('error', (err) => this.destroy(err));

    this._source = sourceStream;
  }

  _read() {
    this._maybePush();
  }

  _maybePush() {
    if (!this.started) return; // withholding until threshold met
    while (this.queue.length) {
      const chunk = this.queue.shift();
      if (!this.push(chunk)) return; // downstream backpressure, wait for next _read
    }
    if (this.sourceEnded) this.push(null);
  }

  _destroy(err, callback) {
    this._source.destroy?.();
    callback(err);
  }
}
