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

// _buildResource is stubbed to a promise that never resolves, standing in
// for the full extraction+SABR+prebuffer pipeline potentially taking
// several seconds. If enqueue()/enqueueMany() ever went back to awaiting
// _playNext() directly (instead of firing it in the background), these
// would hang and get killed by node:test's own default test timeout --
// that failure IS the regression signal, there's no separate assertion
// needed for "didn't hang".

test('enqueue() resolves without waiting for the background playback pipeline', async () => {
  const player = makePlayer();
  player._buildResource = () => new Promise(() => {});
  await player.enqueue(track('a'));
  // The synchronous part of _playNext() (queue.next()) still ran before
  // hitting the never-resolving await -- confirms the background
  // pipeline actually started, not just that enqueue() returned early
  // for some unrelated reason.
  assert.equal(player.queue.playing?.videoId, 'a');
  player.disconnect();
});

test('enqueueMany() resolves without waiting for the background playback pipeline', async () => {
  const player = makePlayer();
  player._buildResource = () => new Promise(() => {});
  await player.enqueueMany([track('a'), track('b')]);
  assert.equal(player.queue.playing?.videoId, 'a');
  assert.equal(player.queue.list().length, 1); // 'b' still queued behind it
  player.disconnect();
});

test('enqueue() still updates the panel synchronously when something is already playing', async () => {
  const player = makePlayer();
  player.queue.playing = track('now-playing');
  let panelUpdated = false;
  player._updatePanelInPlace = () => { panelUpdated = true; };
  await player.enqueue(track('next-up'));
  assert.equal(panelUpdated, true);
  player.disconnect();
});
