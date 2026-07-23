import 'dotenv/config';

function num(name, fallback) {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

export const config = {
  port: num('PORT', 8080),
  discordToken: process.env.DISCORD_TOKEN,
  callbackSecret: process.env.CALLBACK_SECRET || '',

  potProviderUrl: process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416',
  potRefreshRetries: num('POT_REFRESH_RETRIES', 5),
  potRefreshBackoffMs: num('POT_REFRESH_BACKOFF_MS', 750),
  potCacheTtlMs: num('POT_CACHE_TTL_MS', 600_000),

  youtubeCookies: process.env.YOUTUBE_COOKIES_BASE64
    ? Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf-8')
    : (process.env.YOUTUBE_COOKIES || ''),

  maxConcurrentStreams: num('MAX_CONCURRENT_STREAMS', 1),
};
