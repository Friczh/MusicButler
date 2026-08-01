'use strict';

// Single source of truth for the verbose-logging toggle (item #3): every
// debug() call anywhere in the codebase goes through this one gate, so
// there's exactly one place to check/change it instead of a scattered
// `if (process.env.MB_VERBOSE)` in every module that wants to log.
const VERBOSE = process.env.MB_VERBOSE === 'true';

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // "Month:Day, Hour:Min:Sec" — deliberately not a full ISO timestamp;
  // this is for eyeballing a live log stream, not machine parsing.
  return `${pad(d.getMonth() + 1)}:${pad(d.getDate())}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prefix(scope) {
  return `[${timestamp()}] [${scope}]`;
}

const log = {
  /** Gated by MB_VERBOSE — off (nothing printed) unless it's exactly 'true'. */
  debug(scope, ...args) {
    if (!VERBOSE) return;
    console.log(prefix(scope), ...args);
  },
  /** Always printed — for the small set of one-line lifecycle events (login, ready, command registration) that mattered before this file existed. */
  info(scope, ...args) {
    console.log(prefix(scope), ...args);
  },
  /** Always printed, to stderr. */
  error(scope, ...args) {
    console.error(prefix(scope), ...args);
  },
  isVerbose: () => VERBOSE,
};

module.exports = { log };
