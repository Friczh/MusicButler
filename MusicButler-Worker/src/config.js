import 'dotenv/config';

function num(name, fallback) {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

function parseCookies(raw) {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Netscape cookie file format (cookies.txt exports): comment header,
  // tab-separated columns per line: domain, flag, path, secure, expiry, name, value.
  // youtubei.js wants a plain `Cookie:` header string ("name=value; name2=value2"),
  // not this file format — convert.
  if (trimmed.includes('\t') || trimmed.startsWith('# Netscape')) {
    const pairs = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('\t'))
      .filter((cols) => cols.length >= 7)
      .map(([, , , , , name, value]) => `${name}=${value}`);
    return pairs.length ? pairs.join('; ') : undefined;
  }

  // Already in "name=value; name2=value2" header format — pass through.
  return trimmed;
}

export const config = {
  port: num('PORT', 8080),
  discordToken: process.env.DISCORD_TOKEN,
  callbackSecret: process.env.CALLBACK_SECRET || '',

  potProviderUrl: process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416',
  potRefreshRetries: num('POT_REFRESH_RETRIES', 5),
  potRefreshBackoffMs: num('POT_REFRESH_BACKOFF_MS', 750),
  potCacheTtlMs: num('POT_CACHE_TTL_MS', 600_000),

  youtubeCookies: parseCookies(
    process.env.YOUTUBE_COOKIES_BASE64
      ? Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf-8')
      : (process.env.YOUTUBE_COOKIES || '')
  ),

  maxConcurrentStreams: num('MAX_CONCURRENT_STREAMS', 1),
};
