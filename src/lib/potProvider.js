'use strict';

// Client for jim60105/bgutil-ytdlp-pot-provider-rs running in HTTP server
// mode (`bgutil-pot server`). Real contract, confirmed against the project's
// README (v0.8.x):
//   GET  /ping                                    -> 200 if ready
//   POST /get_pot { "content_binding": "<...>" }   -> { "po_token": "<...>" }
//   POST /invalidate_it { "content_binding": "<...>" } -> 200
// Do NOT use /token or a video_id/data_sync_id body — those belonged to the
// older TypeScript implementation and are not this binary's contract.
//
// /get_pot is fronted by SessionDataCaches (content_binding -> po_token),
// checked before any real BotGuard solve -- calling /get_pot again after a
// rejected token just returns the same cached value. /invalidate_it clears
// that cache entry only (not the whole server), forcing the next /get_pot
// for the same content_binding to do a genuine fresh solve.

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
 * @returns {Promise<string>} po_token
 */
async function getPoToken(contentBinding, baseUrl = DEFAULT_BASE_URL) {
  if (!contentBinding) {
    throw new Error('getPoToken: contentBinding is required');
  }
  const res = await fetchWithTimeout(
    `${baseUrl}/get_pot`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_binding: contentBinding }),
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
    `minted ${tokenFingerprint(token)} for content_binding tail=…${contentBinding.slice(-6)}`
  );
  return token;
}

/**
 * Clears the cached po_token for `contentBinding` in bgutil-rust's
 * SessionDataCaches, so the next getPoToken() call for the same binding
 * does a real BotGuard solve instead of returning the same rejected token.
 * Best-effort: a failure here shouldn't block the caller's subsequent
 * getPoToken() retry, so this resolves false on error rather than throwing.
 * @param {string} contentBinding
 * @param {string} baseUrl
 * @returns {Promise<boolean>} true if the invalidation call succeeded
 */
async function invalidateToken(contentBinding, baseUrl = DEFAULT_BASE_URL) {
  if (!contentBinding) {
    throw new Error('invalidateToken: contentBinding is required');
  }
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/invalidate_it`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_binding: contentBinding }),
      },
      REQUEST_TIMEOUT_MS
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error('potProvider', `/invalidate_it failed: HTTP ${res.status} ${text}`);
      return false;
    }
    log.debug('potProvider', `invalidated cached token for content_binding tail=…${contentBinding.slice(-6)}`);
    return true;
  } catch (err) {
    log.error('potProvider', `/invalidate_it request failed: ${err.message}`);
    return false;
  }
}

module.exports = { waitForReady, getPoToken, invalidateToken, DEFAULT_BASE_URL };
