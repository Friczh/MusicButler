'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GuildPlayer } = require('../src/lib/player');
const { GuildQueue } = require('../src/lib/queueManager');
const { config } = require('../src/lib/config');

function makePlayer(onIdleTimeout) {
  const queue = new GuildQueue('g1');
  const player = new GuildPlayer('g1', queue, null, onIdleTimeout);
  // pause()/resume() are being tested for their TIMER side effects, not
  // real @discordjs/voice audio-state transitions (which would require an
  // actual playing/buffering AudioPlayer) -- stub the underlying calls to
  // report success so the timer bookkeeping around them can be exercised
  // in isolation.
  player.audioPlayer.pause = () => true;
  player.audioPlayer.unpause = () => true;
  return player;
}

// idleTimeoutMin is a shared config singleton -- every test sets and
// restores it explicitly so ordering/failures in one test can't leak into
// another.
function withIdleTimeout(minutes, fn) {
  const original = config.idleTimeoutMin;
  config.idleTimeoutMin = minutes;
  try {
    return fn();
  } finally {
    config.idleTimeoutMin = original;
  }
}

test('alone timer: starts on empty VC, fires onIdleTimeout after the configured duration', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    let fired = 0;
    const player = makePlayer(() => fired++);
    player.handleVoicePopulationChange(true);
    assert.ok(player._aloneTimer);
    t.mock.timers.tick(5 * 60_000 - 1);
    assert.equal(fired, 0);
    t.mock.timers.tick(1);
    assert.equal(fired, 1);
  });
});

test('alone timer: rejoin cancels the countdown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    const player = makePlayer(() => {});
    player.handleVoicePopulationChange(true); // last human leaves -> pause + count down
    player.handleVoicePopulationChange(false); // someone rejoins
    assert.equal(player._aloneTimer, null);
  });
});

test('rejoin clears both the alone timer and any independently-running idle timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    let fired = false;
    const player = makePlayer(() => { fired = true; });
    player.handleVoicePopulationChange(true); // pause() -> both timers start
    player.handleVoicePopulationChange(false); // rejoin -> both timers cancelled
    assert.equal(player._aloneTimer, null);
    assert.equal(player._idleTimer, null);
    t.mock.timers.tick(10 * 60_000);
    assert.equal(fired, false);
  });
});

test('rejoin clears a pre-existing idle timer that started before everyone left', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    let fired = false;
    const player = makePlayer(() => { fired = true; });
    player.pause(); // e.g. manual /pause while people are still in VC -> idle timer starts
    const idleTimer = player._idleTimer;
    assert.ok(idleTimer);
    player.handleVoicePopulationChange(true); // everyone leaves -> alone timer also starts
    assert.ok(player._aloneTimer);
    assert.equal(player._idleTimer, idleTimer); // untouched while still empty
    player.handleVoicePopulationChange(false); // someone rejoins -> both cleared
    assert.equal(player._aloneTimer, null);
    assert.equal(player._idleTimer, null);
    t.mock.timers.tick(10 * 60_000);
    assert.equal(fired, false);
  });
});

test('alone timer: repeated "still empty" events do not restart the countdown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    const player = makePlayer(() => {});
    player.handleVoicePopulationChange(true);
    const firstTimer = player._aloneTimer;
    t.mock.timers.tick(2 * 60_000);
    player.handleVoicePopulationChange(true); // still empty, no reset
    assert.equal(player._aloneTimer, firstTimer);
  });
});

test('idle timer: starts on pause(), cleared by resume() before it fires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    let fired = false;
    const player = makePlayer(() => { fired = true; });
    player.pause();
    assert.ok(player._idleTimer);
    player.resume();
    assert.equal(player._idleTimer, null);
    t.mock.timers.tick(10 * 60_000);
    assert.equal(fired, false);
  });
});

test('idle timer: fires onIdleTimeout if nothing resumes it in time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    let fired = false;
    const player = makePlayer(() => { fired = true; });
    player.pause();
    t.mock.timers.tick(5 * 60_000);
    assert.equal(fired, true);
  });
});

test('idleTimeoutMin = 0 disables both timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(0, () => {
    const player = makePlayer(() => {});
    player.handleVoicePopulationChange(true);
    assert.equal(player._aloneTimer, null);
    player.pause();
    assert.equal(player._idleTimer, null);
  });
});

test('disconnect() clears both timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withIdleTimeout(5, () => {
    let fired = false;
    const player = makePlayer(() => { fired = true; });
    player.handleVoicePopulationChange(true);
    player.pause();
    player.disconnect();
    assert.equal(player._aloneTimer, null);
    assert.equal(player._idleTimer, null);
    t.mock.timers.tick(10 * 60_000);
    assert.equal(fired, false);
  });
});
