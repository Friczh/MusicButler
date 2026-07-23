const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

function isLocal(hostPart) {
  const host = hostPart.split(':')[0];
  return LOCAL_HOSTS.includes(host);
}

// Accepts: "localhost:8080", "musicbutler-worker-xxxx.onrender.com",
// "http://...", "https://...", "ws://...", "wss://...".
// Returns { httpBase, wsBase } both without trailing slash.
export function normalizeWorkerAddr(addr) {
  let httpBase;

  if (addr.startsWith('https://') || addr.startsWith('http://')) {
    httpBase = addr;
  } else if (addr.startsWith('wss://')) {
    httpBase = `https://${addr.slice('wss://'.length)}`;
  } else if (addr.startsWith('ws://')) {
    httpBase = `http://${addr.slice('ws://'.length)}`;
  } else {
    // bare host:port — default to secure unless it's clearly local
    httpBase = isLocal(addr) ? `http://${addr}` : `https://${addr}`;
  }

  const wsBase = httpBase.startsWith('https://')
    ? `wss://${httpBase.slice('https://'.length)}`
    : `ws://${httpBase.slice('http://'.length)}`;

  return {
    httpBase: httpBase.replace(/\/$/, ''),
    wsBase: wsBase.replace(/\/$/, ''),
  };
}
