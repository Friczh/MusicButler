'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GuildPlayer } = require('../src/lib/player');
const { GuildQueue } = require('../src/lib/queueManager');

function track(id) {
  return { videoId: id, title: id };
}

function makePlayer() {
  const queue = new GuildQueue('g1');
  const player = new GuildPlayer('g1', queue, null, () => {});
  player.audioPlayer.play = () => {}; // stub -- not exercising real @discordjs/voice playback
  return player;
}

// Some cases below end with the queue empty, which starts the real idle
// auto-exit timer (config.idleTimeoutMin defaults to 5 real minutes) --
// left uncleared, that setTimeout keeps the test process alive well past
// any sane test timeout. disconnect() clears both auto-exit timers, so
// every test cleans up its player via this regardless of whether that
// particular case actually hit the idle-timer path.
function withCleanup(fn) {
  return async (t) => {
    let player;
    try {
      player = await fn(t);
    } finally {
      player?.disconnect();
    }
  };
}

test('repeat-one: a transient extraction failure is retried, not dropped', withCleanup(async (t) => {
  const player = makePlayer();
  const a = track('a');
  player.queue.playing = a;
  player.queue.repeatMode = 'one';

  let attempts = 0;
  player._buildResource = async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error('transient failure');
    return {}; // succeeds on the 3rd attempt
  };

  await player._playNext(); // natural track-end -> repeat-one -> fails twice -> succeeds
  assert.equal(attempts, 3);
  assert.equal(player.queue.playing, a); // still the same track, now playing successfully
  assert.equal(player._errorRetryCount, 0); // reset on success
  return player;
}));

test('repeat-all, single track: retries the same track on error before giving up', withCleanup(async (t) => {
  const player = makePlayer();
  const a = track('a');
  player.queue.playing = a;
  player.queue.repeatMode = 'all';

  let attempts = 0;
  player._buildResource = async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error('transient failure');
    return {};
  };

  await player._playNext();
  assert.equal(attempts, 3);
  assert.equal(player.queue.playing, a);
  return player;
}));

test('retries are capped -- a permanently broken track is eventually dropped, not retried forever', withCleanup(async (t) => {
  const player = makePlayer();
  const a = track('a');
  player.queue.playing = a;
  player.queue.repeatMode = 'one';

  let attempts = 0;
  player._buildResource = async () => {
    attempts += 1;
    throw new Error('permanently broken');
  };

  await player._playNext();
  // 1 initial attempt + MAX_ERROR_RETRIES (2) retries = 3 total, then give up.
  assert.equal(attempts, 3);
  assert.equal(player.queue.playing, null); // dropped, not stuck replaying forever
  return player;
}));

test('repeat off: an error drops the track immediately, no retries', withCleanup(async (t) => {
  const player = makePlayer();
  const a = track('a');
  player.queue.playing = a;
  player.queue.repeatMode = 'off';

  let attempts = 0;
  player._buildResource = async () => {
    attempts += 1;
    throw new Error('failure');
  };

  // Simulates the audioPlayer 'error' event firing for the currently
  // playing track -- _buildResource is never even re-attempted for it,
  // since repeat is off (canRetryOnError is unconditionally false).
  await player._playNext({ isError: true });
  assert.equal(attempts, 0);
  assert.equal(player.queue.playing, null);
  return player;
}));

test('a successful play resets the retry budget for a later, unrelated failure', withCleanup(async (t) => {
  const player = makePlayer();
  const a = track('a');
  const b = track('b');
  player.queue.playing = a;
  player.queue.repeatMode = 'one';

  let attempts = 0;
  // a: fails twice then succeeds (uses up 2 of its retry budget)
  player._buildResource = async (t) => {
    attempts += 1;
    if (t.videoId === 'a' && attempts <= 2) throw new Error('a transient failure');
    return {};
  };
  await player._playNext();
  assert.equal(player._errorRetryCount, 0); // reset after a's successful play

  // Now simulate b failing twice then succeeding too -- should get its
  // own full budget, not fail immediately because a already used 2.
  attempts = 0;
  player.queue.playing = b;
  player._buildResource = async (t) => {
    attempts += 1;
    if (t.videoId === 'b' && attempts <= 2) throw new Error('b transient failure');
    return {};
  };
  await player._playNext(); // natural attempt for b, same shape as a's above
  assert.equal(attempts, 3);
  assert.equal(player.queue.playing, b);
  return player;
}));
