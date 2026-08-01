'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadLogWithVerbose(value) {
  const modPath = require.resolve('../src/lib/log');
  delete require.cache[modPath];
  const prev = process.env.MB_VERBOSE;
  if (value === undefined) delete process.env.MB_VERBOSE;
  else process.env.MB_VERBOSE = value;
  const { log } = require('../src/lib/log');
  if (prev === undefined) delete process.env.MB_VERBOSE;
  else process.env.MB_VERBOSE = prev;
  return log;
}

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errors };
}

test('log.debug is silent when MB_VERBOSE is unset (default off)', () => {
  const log = loadLogWithVerbose(undefined);
  const { logs } = captureConsole(() => log.debug('test', 'hello'));
  assert.equal(logs.length, 0);
});

test('log.debug is silent when MB_VERBOSE is any value other than the literal string "true"', () => {
  const log = loadLogWithVerbose('1');
  const { logs } = captureConsole(() => log.debug('test', 'hello'));
  assert.equal(logs.length, 0);
});

test('log.debug prints when MB_VERBOSE=true', () => {
  const log = loadLogWithVerbose('true');
  const { logs } = captureConsole(() => log.debug('test', 'hello'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[\d{2}:\d{2}, \d{2}:\d{2}:\d{2}\] \[test\] hello$/);
});

test('log.info always prints regardless of MB_VERBOSE', () => {
  const log = loadLogWithVerbose(undefined);
  const { logs } = captureConsole(() => log.info('test', 'hi'));
  assert.equal(logs.length, 1);
});

test('log.error always prints to stderr regardless of MB_VERBOSE', () => {
  const log = loadLogWithVerbose(undefined);
  const { errors } = captureConsole(() => log.error('test', 'boom'));
  assert.equal(errors.length, 1);
});

test('isVerbose() reflects MB_VERBOSE at load time', () => {
  assert.equal(loadLogWithVerbose('true').isVerbose(), true);
  assert.equal(loadLogWithVerbose('false').isVerbose(), false);
  assert.equal(loadLogWithVerbose(undefined).isVerbose(), false);
});
