'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTimeout } = require('../src/commands/play');

test('withTimeout: resolves with the underlying value when it finishes first', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000, 'should not fire');
  assert.equal(result, 'ok');
});

test('withTimeout: rejects with the given message if the timeout elapses first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const neverResolves = new Promise(() => {}); // simulates a stalled network call
  const pending = assert.rejects(
    withTimeout(neverResolves, 5000, 'timed out message'),
    /timed out message/
  );
  t.mock.timers.tick(5000);
  await pending;
});

test('withTimeout: propagates the underlying rejection, not a timeout, when it fails first', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('real failure')), 5000, 'timed out message'),
    /real failure/
  );
});
