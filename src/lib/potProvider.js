'use strict';

// Client for jim60105/bgutil-ytdlp-pot-provider-rs running in HTTP server
// mode (`bgutil-pot server`). Real contract, confirmed against the actual
// Rust source (session/manager.rs, server/handlers.rs, types/request.rs):
//   GET  /ping                                                  -> 200 if ready
//   POST /get_pot { content_binding, bypass_cache? }             -> { po_token }
// Do NOT use /token or a video_id/data_sync_id body — those belonged to the
// older TypeScript implementation and are not this binary's contract.
//
// generate_pot_token() checks a content_binding -> po_token cache
// (session_data_caches) FIRST, before any BotGuard solve, UNLESS
// request.bypass_cache is true -- in which case it skips the cache check
// unconditionally and always does a fresh solve. This is the only
// per-content_binding way to force a fresh token.
//
// /invalidate_it looked like the right tool but isn't: it only expires
// entries in a DIFFERENT cache (minter_cache, the BotGuard token minter),
// not session_data_caches -- so it has no effect on the "still fresh,
// returning cached token" path. The only thing that clears
// session_data_caches is /invalidate_caches, which nukes ALL content
// bindings server-wide, not just this one -- too blunt for a single
// video's stuck attestation. bypass_cache on /get_pot is scoped correctly
// and is the mechanism this file uses.

const { log } = require('./log');

const DEFAULT_BASE_URL = process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416';
const PING_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;

// Never log a full PO token, only enough to correlate mints in a log stream.
function tokenFingerprint(token) {
  if (!token) return '<none>';
  return `len=${token.length} tail=…${token.slice(-6)}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls GET /ping until the sidecar responds 200 or attempts are exhausted.
 * Intended to be called by start.sh (or index.js on boot) before any
 * playback is attempted.
 */
async function waitForReady(baseUrl = DEFAULT_BASE_URL, { retries = 20, delayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/ping`, { method: 'GET' }, PING_TIMEOUT_MS);
      if (res.ok) return true;
      lastError = new Error(`ping returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `POT provider at ${baseUrl} did not become ready after ${retries} attempts: ${lastError?.message}`
  );
}

/**
 * @param {string} contentBinding - session visitor_data (NOT a video id) for
 *   the session-bound token youtubei.js's `po_token` option expects.
 * @param {string} baseUrl
 * @param {{ bypassCache?: boolean }} [opts] - bypassCache forces a fresh
 *   BotGuard solve instead of returning a cached (possibly already-rejected)
 *   token for this content_binding. Use for refresh/retry calls; leave
 *   false for the normal first mint, where a cache hit is desirable.
 * @returns {Promise<string>} po_token
 */
async function getPoToken(contentBinding, baseUrl = DEFAULT_BASE_URL, { bypassCache = false } = {}) {
  if (!contentBinding) {
    throw new Error('getPoToken: contentBinding is required');
  }
  const res = await fetchWithTimeout(
    `${baseUrl}/get_pot`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_binding: contentBinding, bypass_cache: bypassCache }),
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POT provider /get_pot failed: HTTP ${res.status} ${text}`);
  }
  const data = await res.json();
  // Request body is snake_case, but the binary's response uses camelCase
  // (poToken) inconsistently -- accepting both rather than betting on one.
  const token = (data && (data.po_token || data.poToken)) || null;
  if (!token || typeof token !== 'string' || token.length === 0) {
    throw new Error(`POT provider /get_pot response missing po_token/poToken: ${JSON.stringify(data)}`);
  }
  log.debug(
    'potProvider',
    `minted ${tokenFingerprint(token)} for content_binding tail=…${contentBinding.slice(-6)}` +
    `${bypassCache ? ' (cache bypassed)' : ''}`
  );
  return token;
}

module.exports = { waitForReady, getPoToken, DEFAULT_BASE_URL };
