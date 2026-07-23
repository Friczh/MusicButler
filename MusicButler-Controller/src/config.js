import 'dotenv/config';

function num(name, fallback) {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,

  workerAddr: process.env.WORKER_ADDR || 'localhost:8080',
  callbackSecret: process.env.CALLBACK_SECRET || '',

  heartbeatIntervalMs: num('HEARTBEAT_INTERVAL_MS', 1000),
  heartbeatTimeoutMs: num('HEARTBEAT_TIMEOUT_MS', 3000),

  controlReconnectDelayMs: num('CONTROL_RECONNECT_DELAY_MS', 2000),
};
