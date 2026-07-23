import { createServer } from 'node:http';

// Controller's actual job (Discord gateway + WS client to Worker) makes no
// outbound-listening connections of its own. Render's free tier only
// offers a no-cost plan for Web Services, which require a bound port to
// pass health checks — Background Workers have no free option. This is a
// deliberate shim, not a real feature: it exists purely to satisfy Render's
// port scan so Controller can run on the free Web Service tier.
export function startPortShim(getStatus) {
  const port = process.env.PORT || 8080;

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(getStatus?.() ?? { status: 'ok' }));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[shim] Port shim listening on ${port} (Render free-tier requirement, not a real feature)`);
  });

  return server;
}
