'use strict';

const { Innertube, UniversalCache, Platform, ClientType, Constants, Parser } = require('youtubei.js');
const { getPoToken } = require('./potProvider');
const { decodeCookiesEnv } = require('./cookies');

// youtubei.js requires a JS evaluator for deciphering signature-cipher
// formats, even in Node.js -- without this, download() throws.
Platform.shim.eval = async (data) => new Function(data.output)();

// Replaces youtubei.js's default multi-line-dump parser warning with one
// line. Non-fatal either way -- getInfo() still completes normally.
// To go fully silent: Parser.setParserErrorHandler(() => {});
Parser.setParserErrorHandler(({ classname, error_type, ...context }) => {
  let detail;
  switch (error_type) {
    case 'parse':
      detail = context.error instanceof Error ? context.error.message : 'parse error';
      break;
    case 'typecheck':
      detail = `expected ${Array.isArray(context.expected) ? context.expected.join('|') : context.expected}`;
      break;
    case 'class_not_found':
      detail = 'no parser class yet (new YouTube UI element)';
      break;
    case 'class_changed':
      detail = `keys changed: ${(context.changed_keys || []).map(([k]) => k).join(', ')}`;
      break;
    case 'mutation_data_missing':
      detail = 'mutation data missing';
      break;
    case 'mutation_data_invalid':
      detail = `${context.failed}/${context.total} items missing valid mutation data`;
      break;
    default:
      detail = error_type || 'unknown';
  }
  console.warn(`[youtubei.js parser] ${error_type}: ${classname} — ${detail}`);
});

// Session bootstrap needs the raw internal client name (ClientType enum),
// not the friendly alias accepted elsewhere as a per-call override.
const CLIENT_TYPE_FOR = {
  WEB: ClientType.WEB,
  YTMUSIC: ClientType.MUSIC,
};

// po_token is bound to visitor_data, which is minted per client context --
// a WEB-bootstrapped token isn't valid for YTMUSIC requests. So: bootstrap
// a session per client_type to get its visitor_data, mint a token bound
// to that, then rebuild the session with both. Cached per client_type.
const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5h

let cookieHeader = null;
// clientType -> { session, tokenIssuedAt, refreshPromise }
const sessions = new Map();

function getCookieHeader() {
  if (!cookieHeader) {
    cookieHeader = decodeCookiesEnv(process.env.YOUTUBE_COOKIES_BASE64);
  }
  return cookieHeader;
}

async function bootstrapVisitorData(clientType) {
  const bootstrap = await Innertube.create({
    client_type: CLIENT_TYPE_FOR[clientType],
    cookie: getCookieHeader(),
    cache: new UniversalCache(false),
    generate_session_locally: true,
  });
  const visitorData = bootstrap.session?.context?.client?.visitorData;
  if (!visitorData) {
    throw new Error(`bootstrapVisitorData(${clientType}): failed to obtain visitor_data from bootstrap session`);
  }
  // Returned alongside visitorData (not re-derived later) so buildSession
  // can pass it straight to potProvider.getPoToken without a second
  // bootstrap Innertube.create() call just to get a context object.
  return { visitorData, context: bootstrap.session.context };
}

async function buildSession(clientType) {
  const { visitorData, context } = await bootstrapVisitorData(clientType);
  // BotGuard's VM/interpreter isn't client_type-specific -- only the
  // content_binding (visitor_data here) differs -- so this reuses one
  // shared, process-wide BotGuard instance (see potProvider.js) instead
  // of building a separate jsdom+VM per client_type. context is only
  // used by potProvider's InnerTube att/get fallback path, if the
  // watch-page embed didn't include an inline interpreter URL.
  const poToken = await getPoToken(visitorData, context);
  const session = await Innertube.create({
    client_type: CLIENT_TYPE_FOR[clientType],
    cookie: getCookieHeader(),
    cache: new UniversalCache(false),
    generate_session_locally: true,
    visitor_data: visitorData,
    po_token: poToken,
  });
  return session;
}

/**
 * Returns a cached, attested Innertube session for the given client_type
 * ('WEB' or 'YTMUSIC'), transparently rebuilding it (and fetching a fresh
 * po_token bound to that client's own visitor_data) if it's missing,
 * expired, or a refresh is explicitly requested.
 */
async function getSession({ clientType = 'WEB', forceRefresh = false } = {}) {
  if (!(clientType in CLIENT_TYPE_FOR)) {
    throw new Error(`getSession: unknown clientType "${clientType}" (expected one of: ${Object.keys(CLIENT_TYPE_FOR).join(', ')})`);
  }
  let entry = sessions.get(clientType);
  const expired = !entry || Date.now() - entry.tokenIssuedAt > TOKEN_TTL_MS;

  if (entry?.session && !forceRefresh && !expired) {
    return entry.session;
  }

  // Coalesce concurrent callers (per client_type) into a single rebuild.
  if (!entry?.refreshPromise) {
    const refreshPromise = buildSession(clientType).then((session) => {
      sessions.set(clientType, { session, tokenIssuedAt: Date.now(), refreshPromise: null });
      return session;
    });
    sessions.set(clientType, { session: entry?.session ?? null, tokenIssuedAt: entry?.tokenIssuedAt ?? 0, refreshPromise });
    return refreshPromise;
  }
  return entry.refreshPromise;
}

/**
 * Builds the `clientInfo` googlevideo's SabrStream needs to identify
 * itself in SABR requests. `clientName` is the numeric client ID
 * (Constants.CLIENT_NAME_IDS), not the friendly name. `clientVersion`
 * comes from the already-bootstrapped session.
 * @param {import('youtubei.js').Innertube} session
 * @param {'WEB' | 'YTMUSIC'} clientType
 * @returns {{ clientName: number, clientVersion: string }}
 */
function getSabrClientInfo(session, clientType) {
  const rawName = CLIENT_TYPE_FOR[clientType];
  const clientNameId = Constants.CLIENT_NAME_IDS[rawName];
  if (!clientNameId) {
    throw new Error(`getSabrClientInfo: no CLIENT_NAME_IDS entry for "${rawName}" (clientType "${clientType}")`);
  }
  return {
    clientName: Number(clientNameId),
    clientVersion: session.session.client_version,
  };
}

module.exports = { getSession, getSabrClientInfo };
