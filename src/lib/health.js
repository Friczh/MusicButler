'use strict';

const http = require('node:http');

// Render Web Services require binding $PORT and responding 200 to be
// considered live -- this process is otherwise a pure gateway/voice client
// with no inbound HTTP surface of its own. Zero deps (node:http only) since
// this exists purely to satisfy Render's port-binding check, not to serve
// anything meaningful.
function startHealthServer(client) {
  const port = Number(process.env.PORT) || 8080;

  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    if (client.isReady()) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('starting');
    }
  });

  server.listen(port, () => {
    console.log(`[health] listening on :${port}`);
  });

  return server;
}

module.exports = { startHealthServer };
