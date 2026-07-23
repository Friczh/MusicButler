import WebSocket from 'ws';
import { config } from '../config.js';
import { normalizeWorkerAddr } from './addr.js';

let ws = null;
let reconnectTimer = null;
let handlers = { onTrackEnded: null, onError: null, onStarted: null };

function connect() {
  const { wsBase } = normalizeWorkerAddr(config.workerAddr);
  ws = new WebSocket(`${wsBase}/control`, {
    headers: config.callbackSecret ? { 'x-callback-secret': config.callbackSecret } : {},
  });

  ws.on('open', () => {
    console.log('[control] connected to Worker');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'trackEnded') handlers.onTrackEnded?.(msg.guild_id);
    else if (msg.type === 'error') handlers.onError?.(msg.guild_id, msg.message);
    else if (msg.type === 'started') handlers.onStarted?.(msg.guild_id);
  });

  ws.on('close', () => {
    console.warn('[control] disconnected from Worker, reconnecting...');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[control] connection error:', err.message);
  });

  ws.on('unexpected-response', (req, res) => {
    console.error(`[control] handshake rejected: ${res.statusCode} (check CALLBACK_SECRET matches on both services)`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, config.controlReconnectDelayMs);
}

function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  console.warn('[control] not connected, dropped command:', payload.action);
  return false;
}

export function startControlClient(eventHandlers) {
  handlers = { ...handlers, ...eventHandlers };
  connect();
}

export function sendPlay(guildId, channelId, videoId) {
  return send({ action: 'play', guild_id: guildId, channel_id: channelId, video_id: videoId });
}
export function sendSkip(guildId) {
  return send({ action: 'skip', guild_id: guildId });
}
export function sendPause(guildId) {
  return send({ action: 'pause', guild_id: guildId });
}
export function sendResume(guildId) {
  return send({ action: 'resume', guild_id: guildId });
}
export function sendLeave(guildId) {
  return send({ action: 'leave', guild_id: guildId });
}

// Health check against Worker's plain HTTP endpoint, same as before.
export function startHeartbeat(onUnhealthy) {
  const { httpBase } = normalizeWorkerAddr(config.workerAddr);

  const interval = setInterval(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.heartbeatTimeoutMs);
      const res = await fetch(`${httpBase}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) onUnhealthy(new Error(`Worker health check returned ${res.status}`));
    } catch (err) {
      onUnhealthy(err);
    }
  }, config.heartbeatIntervalMs);

  return () => clearInterval(interval);
}
