'use strict';

const REPEAT_MODES = ['off', 'all', 'one'];
// Bounded so a long-running session with repeat off (or on, for that
// matter) can't grow this array forever -- it's cheap per-track (small
// objects), but there's no reason to keep more than this many.
const MAX_HISTORY = 500;

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    /** @type {Array<object>} */
    this.tracks = [];
    this.playing = null;
    // Every track that has finished playing, in play order -- recorded
    // unconditionally in next(), regardless of what repeatMode was
    // active at the time. This is what repeat-all pulls from once
    // `tracks` runs dry, which is the whole point: if repeat-all only
    // remembered tracks that finished while it was already on, turning
    // it on partway through a session would strand whatever had already
    // played, and repeat-all would end up only looping the most recent
    // song instead of the actual queue. See next().
    this.history = [];
    // Bumped on every skip/leave/clear-on-disconnect so an in-flight
    // extraction that was already running for a track can detect it's
    // stale and avoid clobbering whatever plays next.
    this.generation = 0;
    this.voiceChannelId = null;
    this.textChannelId = null;
    // ID of the currently-live control panel message in textChannelId, if
    // any -- see panel.js. Repost-on-track-change replaces this; leaving/
    // /clearmessage clears it out via messageCleanup.js.
    this.panelMessageId = null;
    // 'off' | 'all' (loop the whole queue, including whatever's currently
    // playing) | 'one' (loop just the current track) -- honored here in
    // next() (repeat-all) and in player.js's _playNext() (repeat-one,
    // which never touches history -- it replays the same track object
    // directly without going through next() at all).
    this.repeatMode = 'off';
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
    // Record whatever was just playing into history BEFORE replacing it
    // -- unconditionally, regardless of repeatMode right now. This is
    // the fix: repeat-all needs to be able to loop back to tracks that
    // finished before it was even turned on, not just ones that finish
    // while it's already active. Silent tracks (grantop's rickroll) are
    // a one-off hijack, not part of the real queue, so they're excluded.
    if (this.playing && !this.playing.silent) {
      this.history.push(this.playing);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }

    if (this.tracks.length === 0 && this.repeatMode === 'all' && this.history.length > 0) {
      // Upcoming queue is empty but repeat-all is on -- refill it from
      // everything that's been played this session, in original order,
      // and start the cycle over.
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

  /** Randomizes the order of upcoming tracks -- a one-time action, not a persistent mode. Returns the resulting track count. */
  shuffle() {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
    return this.tracks.length;
  }

  clear() {
    this.tracks = [];
    this.history = [];
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
