import fetch from 'node-fetch';
import { config } from '../config.js';

const cache = new Map(); // videoId -> { token, expiresAt }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getPoToken(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  let lastErr;
  for (let attempt = 1; attempt <= config.potRefreshRetries; attempt++) {
    try {
      const res = await fetch(`${config.potProviderUrl}/get_pot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content_binding: videoId }),
      });
      if (!res.ok) throw new Error(`POT provider returned ${res.status}`);
      const body = await res.json();
      const token = body.po_token;
      if (!token) throw new Error(`Unexpected response shape from POT provider: ${JSON.stringify(body)}`);

      cache.set(videoId, { token, expiresAt: Date.now() + config.potCacheTtlMs });
      return token;
    } catch (err) {
      lastErr = err;
      const backoff = config.potRefreshBackoffMs * attempt;
      console.warn(`[pot] attempt ${attempt} failed: ${err.message}, retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw new Error(`PO token fetch failed after ${config.potRefreshRetries} attempts: ${lastErr?.message}`);
}
