'use strict';

const { Transform } = require('node:stream');

/**
 * Withholds all output until `targetBytes` worth of data has accumulated,
 * then emits everything buffered so far as one chunk and passes any
 * subsequent chunks straight through. Operates on raw bytes (safe to use
 * before demuxing — no frame boundaries to respect at this stage).
 *
 * Emits 'prebuffered' exactly once, right before the held-back data is
 * finally pushed downstream — either because the target was reached,
 * because the source ended first (short streams still get a
 * 'prebuffered' event, just for whatever they actually had), or because
 * the caller gave up waiting and called forceRelease().
 */
class PrebufferTransform extends Transform {
  constructor({ targetBytes, ...streamOptions }) {
    super(streamOptions);
    if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
      throw new Error('PrebufferTransform: targetBytes must be a positive number');
    }
    this.targetBytes = targetBytes;
    this._chunks = [];
    this._bufferedBytes = 0;
    this._released = false;
  }

  _transform(chunk, _encoding, callback) {
    if (this._released) {
      callback(null, chunk);
      return;
    }
    this._chunks.push(chunk);
    this._bufferedBytes += chunk.length;
    if (this._bufferedBytes >= this.targetBytes) {
      this._release(callback);
    } else {
      callback();
    }
  }

  _flush(callback) {
    if (!this._released && this._chunks.length > 0) {
      this._release(callback);
    } else {
      callback();
    }
  }

  _release(callback) {
    this._released = true;
    const combined = Buffer.concat(this._chunks);
    this._chunks = [];
    this.emit('prebuffered', { bufferedBytes: this._bufferedBytes });
    callback(null, combined);
  }

  /**
   * Releases whatever's buffered right now, without waiting for
   * targetBytes. For use when a caller has decided to stop waiting (e.g.
   * a prebuffer timeout) but stage1 itself has no way to know that on its
   * own — without this, _transform keeps withholding data until
   * targetBytes is eventually reached regardless of any timeout the
   * caller applied, silently defeating the point of giving up early.
   *
   * Safe to call from outside a _transform/_flush callback: unlike
   * _release (which hands its data back via the Transform callback
   * machinery), this pushes directly via this.push(), which Transform
   * (as a Duplex) allows at any time, not just mid-_transform.
   */
  forceRelease() {
    if (this._released) return;
    this._released = true;
    const bufferedBytes = this._bufferedBytes;
    if (this._chunks.length > 0) {
      const combined = Buffer.concat(this._chunks);
      this._chunks = [];
      this.emit('prebuffered', { bufferedBytes });
      this.push(combined);
    } else {
      this.emit('prebuffered', { bufferedBytes: 0 });
    }
  }
}

module.exports = { PrebufferTransform };
