// Single-guild queue. Position 0 = currently playing (not part of this array).
class QueueManager {
  constructor() {
    this.queue = [];       // pending tracks: { videoId, title, requestedBy }
    this.nowPlaying = null;
  }

  add(track) {
    this.queue.push(track);
    return this.queue.length;
  }

  list() {
    return { nowPlaying: this.nowPlaying, upcoming: [...this.queue] };
  }

  clear() {
    this.queue = [];
  }

  remove(position) {
    if (position === 0) {
      return { error: true, message: '/skip is available, are you blind or something?' };
    }
    if (!Number.isInteger(position) || position < 1 || position > this.queue.length) {
      return { error: true, message: 'Invalid queue position.' };
    }
    const [removed] = this.queue.splice(position - 1, 1);
    return { error: false, removed };
  }

  swap(posA, posB) {
    if (posA === 0 || posB === 0) {
      return { error: true, message: "Can't swap the currently playing track." };
    }
    if (![posA, posB].every((p) => Number.isInteger(p) && p >= 1 && p <= this.queue.length)) {
      return { error: true, message: 'Invalid queue position.' };
    }
    [this.queue[posA - 1], this.queue[posB - 1]] = [this.queue[posB - 1], this.queue[posA - 1]];
    return { error: false };
  }

  move(from, to) {
    if (from === 0 || to === 0) {
      return { error: true, message: '/skip is available, are you blind or something?' };
    }
    if (![from, to].every((p) => Number.isInteger(p) && p >= 1 && p <= this.queue.length)) {
      return { error: true, message: 'Invalid queue position.' };
    }
    const [track] = this.queue.splice(from - 1, 1);
    this.queue.splice(to - 1, 0, track);
    return { error: false, track };
  }

  advance() {
    this.nowPlaying = this.queue.shift() || null;
    return this.nowPlaying;
  }
}

export const queueManager = new QueueManager();
