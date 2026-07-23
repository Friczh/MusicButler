import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import * as playbackManager from '../voice/playbackManager.js';

const httpServer = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

if (!config.callbackSecret) {
  console.warn('[control] CALLBACK_SECRET is not set — /control is UNAUTHENTICATED. Set CALLBACK_SECRET on both services before deploying publicly.');
}

const wss = new WebSocketServer({
  server: httpServer,
  path: '/control',
  verifyClient: ({ req }, callback) => {
    if (!config.callbackSecret) {
      callback(true); // no secret configured — dev/local mode, allow (with the warning above)
      return;
    }
    const provided = req.headers['x-callback-secret'];
    if (provided === config.callbackSecret) {
      callback(true);
    } else {
      console.warn('[control] rejected WS connection: bad or missing x-callback-secret');
      callback(false, 401, 'Unauthorized');
    }
  },
});

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid message format.' });
      return;
    }

    try {
      switch (msg.action) {
        case 'play': {
          const { guild_id: guildId, channel_id: channelId, video_id: videoId } = msg;
          await playbackManager.playTrack(guildId, channelId, videoId, (err) => {
            send(ws, err
              ? { type: 'error', guild_id: guildId, message: err.message }
              : { type: 'trackEnded', guild_id: guildId });
          });
          send(ws, { type: 'started', guild_id: guildId });
          break;
        }
        case 'skip':
          playbackManager.skip(msg.guild_id);
          break;
        case 'pause':
          playbackManager.pause(msg.guild_id);
          break;
        case 'resume':
          playbackManager.resume(msg.guild_id);
          break;
        case 'leave':
          playbackManager.leave(msg.guild_id);
          break;
        default:
          send(ws, { type: 'error', message: `Unknown action: ${msg.action}` });
      }
    } catch (err) {
      console.error('[control] error handling action', msg.action, ':', err.message);
      send(ws, { type: 'error', guild_id: msg.guild_id, message: err.message });
    }
  });
});

export function startControlServer() {
  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`[control] Worker listening on port ${config.port}`);
  });
  return httpServer;
}
