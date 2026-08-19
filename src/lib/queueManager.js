'use strict';

const REPEAT_MODES = ['off', 'all', 'one'];
// Caps history growth over a long-running session.
const MAX_HISTORY = 500;

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    /** @type {Array<object>} */
    this.tracks = [];
    this.playing = null;
    // Every finished track, in play order, recorded unconditionally in
    // next() -- what repeat-all refills from once `tracks` runs dry.
    this.history = [];
    // Bumped on skip/leave/clear so a stale in-flight extraction can
    // detect it and avoid clobbering whatever plays next.
    this.generation = 0;
    this.voiceChannelId = null;
    this.textChannelId = null;
    // ID of the live control panel message in textChannelId, if any.
    this.panelMessageId = null;
    // 'off' | 'all' | 'one' -- honored in next() (repeat-all) and in
    // player.js's _playNext() (repeat-one, which bypasses next() entirely).
    this.repeatMode = 'off';
    // originalOrder snapshots `tracks` right before shuffle is applied,
    // so turning shuffle off restores the pre-shuffle order.
    this.shuffleActive = false;
    /** @type {Array<object>|null} */
    this.originalOrder = null;
  }

  add(track) {
    this.tracks.push(track);
    return this.tracks.length;
  }

  /** Batch-append (e.g. a resolved playlist) in one synchronous op. */
  addMany(tracks) {
    this.tracks.push(...tracks);
    return this.tracks.length;
  }

  /** Insert a track at the front of the queue -- plays next, ahead of everything else. */
  addFront(track) {
    this.tracks.unshift(track);
    return this.tracks.length;
  }

  next() {
    // Record unconditionally (regardless of current repeatMode) so
    // repeat-all can loop back to tracks that finished before it was
    // turned on. Silent/easter-egg tracks are excluded.
    if (this.playing && !this.playing.silent) {
      this.history.push(this.playing);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }

    if (this.tracks.length === 0 && this.repeatMode === 'all' && this.history.length > 0) {
      // Refill from everything played this session, restart the cycle.
      this.tracks.push(...this.history);
      this.history = [];
    }

    this.playing = this.tracks.shift() ?? null;
    return this.playing;
  }

  remove(index) {
    if (index < 0 || index >= this.tracks.length) return null;
    return this.tracks.splice(index, 1)[0];
  }

  swap(indexA, indexB) {
    if (
      indexA < 0 || indexA >= this.tracks.length ||
      indexB < 0 || indexB >= this.tracks.length
    ) {
      return false;
    }
    [this.tracks[indexA], this.tracks[indexB]] = [this.tracks[indexB], this.tracks[indexA]];
    return true;
  }

  move(fromIndex, toIndex) {
    if (
      fromIndex < 0 || fromIndex >= this.tracks.length ||
      toIndex < 0 || toIndex >= this.tracks.length
    ) {
      return false;
    }
    const [track] = this.tracks.splice(fromIndex, 1);
    this.tracks.splice(toIndex, 0, track);
    return true;
  }

  /** In-place Fisher-Yates on the upcoming tracks. */
  _shuffleInPlace() {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
  }

  /**
   * Toggles shuffle: on snapshots + shuffles order, off restores the
   * snapshot. Added/removed tracks during shuffle are reconciled by
   * reference -- survivors keep order, new ones append at the end.
   * Refuses to turn on with <=1 track (state untouched). Returns
   * { active, count, refused }.
   */
  toggleShuffle() {
    if (!this.shuffleActive) {
      if (this.tracks.length <= 1) {
        return { active: false, count: this.tracks.length, refused: true };
      }
      this.originalOrder = [...this.tracks];
      this._shuffleInPlace();
      this.shuffleActive = true;
    } else {
      const current = new Set(this.tracks);
      const restored = this.originalOrder.filter((t) => current.has(t));
      const restoredSet = new Set(restored);
      const added = this.tracks.filter((t) => !restoredSet.has(t));
      this.tracks = [...restored, ...added];
      this.originalOrder = null;
      this.shuffleActive = false;
    }
    return { active: this.shuffleActive, count: this.tracks.length };
  }

  clear() {
    this.tracks = [];
    this.history = [];
    this.shuffleActive = false;
    this.originalOrder = null;
  }

  list() {
    return [...this.tracks];
  }

  bumpGeneration() {
    this.generation += 1;
    return this.generation;
  }

  isCurrentGeneration(gen) {
    return gen === this.generation;
  }

  /** Sets repeat mode; ignores an invalid value rather than throwing. Returns the resulting mode. */
  setRepeatMode(mode) {
    if (REPEAT_MODES.includes(mode)) this.repeatMode = mode;
    return this.repeatMode;
  }

  /** Advances to the next mode in off -> all -> one -> off order. Used by the panel's repeat button. */
  cycleRepeatMode() {
    const idx = REPEAT_MODES.indexOf(this.repeatMode);
    this.repeatMode = REPEAT_MODES[(idx + 1) % REPEAT_MODES.length];
    return this.repeatMode;
  }
}

class QueueManager {
  constructor() {
    /** @type {Map<string, GuildQueue>} */
    this.queues = new Map();
  }

  get(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, new GuildQueue(guildId));
    }
    return this.queues.get(guildId);
  }

  delete(guildId) {
    this.queues.delete(guildId);
  }

  has(guildId) {
    return this.queues.has(guildId);
  }
}

module.exports = { QueueManager, GuildQueue, REPEAT_MODES };
