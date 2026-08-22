'use strict';

// Self-managed PO token / BotGuard attestation provider, in-process.
// Replaces the bgutil-rust HTTP sidecar with a direct integration of
// LuanRT/BgUtils (bgutils-js) + jsdom.
//
// Flow, verified against LuanRT/BgUtils's own README ("InnerTube
// challenge fetcher example") and youtubei.js@17.2.0's installed source
// (Innertube.js getAttestationChallenge(), parser/types/ParsedResponse.d.ts
// for the exact bg_challenge/interpreter_url field shape):
//   1. innertube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND') --
//      a plain InnerTube /att/get call via youtubei.js's own request
//      machinery (session headers/context handled for us). No watch-page
//      HTML fetch/scrape -- an earlier version of this file did that,
//      based on an unverified guess at YouTube's embed format, and it
//      was wrong (see git history / prior incident). This is the
//      officially documented approach instead.
//   2. Load the BotGuard interpreter script into a jsdom `window`.
//   3. BotGuardClient.create() + .snapshot() -> BotGuard response.
//   4. POST the BotGuard response + a fixed public requestKey to
//      Google's GenerateIT endpoint -> integrity token.
//   5. WebPoMinter.create() with the integrity token -> mintCallback.
//   6. mintCallback(contentBinding) -> PO token, base64.
//
// NOT implemented here: setting `window.yt = { config_: ytConfig }`
// (an EVENT_ID field BotGuard's interpreter can read) before running the
// interpreter. FreeTube added this (PR #9607) via a full watch-page HTML
// scrape, to fix a *mid-stream SABR reload* freeze -- not a failure of
// initial token minting. Since this file only needs bg_challenge for a
// single ENGAGEMENT_TYPE_UNBOUND mint (no ytConfig available without
// scraping, which we've deliberately dropped), this is left out
// intentionally, not by oversight. If BotGuard attestation specifically
// starts failing mid-SABR-playback (ATTESTATION_PENDING loops -- see
// sabr.js's refetchPoToken path), that's the first thing to revisit,
// since it would line up with exactly what FreeTube's fix addressed.

const { JSDOM, ResourceLoader } = require('jsdom');
const { log } = require('./log');

// `canvas` (node-canvas) isn't imported directly anywhere in this file --
// it's a peer of jsdom (jsdom@26 requires canvas@^3.2.3) that jsdom
// auto-detects and wires up internally to back HTMLCanvasElement's real
// getContext('2d'). Without it, jsdom's canvas is a stub and
// getContext() throws "Not implemented" -- and BotGuard's interpreter
// does call it as part of its environment-integrity/fingerprint check,
// so a missing/stub canvas produces a degraded fingerprint that Google's
// server then rejects (WebPoMinter throws "APF:Failed", confirmed
// against a live failure). LuanRT/BgUtils's own README says as much:
// jsdom alone isn't a "good enough" document implementation for
// Node.js/Deno/Bun; only real Chromium (Electron etc.) works with zero
// extra deps. jim60105's own predecessor TypeScript POT-provider server
// (same stack: bgutils-js + jsdom + youtubei.js) depended on canvas too.
// The prebuilt canvas binary bundles its own libcairo/libpango/etc.
// shared libraries (resolved from node_modules/canvas/build/Release/,
// not system paths), so no Dockerfile apt-get changes are needed for
// this -- verified by inspecting the built binary's actual dynamic
// library dependencies.

// bgutils-js ships ESM-only (package.json "type": "module", no "require"
// export condition) -- plain require('bgutils-js/...') throws
// ERR_REQUIRE_ESM in this CommonJS codebase. dynamic import() is the
// standard interop for consuming an ESM-only package from CJS; cached
// after the first call so every getPoToken() call after startup doesn't
// pay a repeated import() lookup.
let bgUtilsModulesPromise = null;
function loadBgUtils() {
  if (!bgUtilsModulesPromise) {
    bgUtilsModulesPromise = Promise.all([
      import('bgutils-js/botguard'),
      import('bgutils-js/webpo'),
      import('bgutils-js/utils'),
    ]).then(([botguard, webpo, utils]) => ({
      BotGuardClient: botguard.BotGuardClient,
      WebPoMinter: webpo.WebPoMinter,
      buildURL: utils.buildURL,
      GOOG_API_KEY: utils.GOOG_API_KEY,
      parseLooseJSON: utils.parseLooseJSON,
    }));
  }
  return bgUtilsModulesPromise;
}

// Public, well-known YouTube web client requestKey. Same constant used in
// LuanRT/BgUtils's own README example, jim60105's Rust config default,
// and FreeTube's botGuardScript.js. Not a secret -- it identifies the
// *client type* (WEB) to Google's attestation service, not a per-user
// credential.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

// jsdom's default navigator.userAgent literally contains the substring
// "jsdom/<version>" -- confirmed by inspecting jsdom's own installed
// source (lib/jsdom/browser/resources/resource-loader.js's default). A
// plain, well-known UA-sniffing check would treat that as an instant,
// unambiguous synthetic-environment signal. This (a realistic desktop
// Chrome UA, window.chrome presence, navigator.webdriver === false) are
// standard, well-documented headless-browser-detection countermeasures
// -- not YouTube/BotGuard-specific reverse-engineering, just closing
// obvious jsdom-vs-real-browser gaps that any basic fingerprint check
// would otherwise trip on immediately.
const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const CHALLENGE_TIMEOUT_MS = 15000;
const SNAPSHOT_TIMEOUT_MS = 10000;

function tokenFingerprint(token) {
  if (!token) return '<none>';
  return `len=${token.length} tail=…${token.slice(-6)}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A stable, innocuous video ID used only to fetch a watch page for its
// embedded ytcfg blob. The content itself is irrelevant -- only the
// page's embedded config matters, and that's the same regardless of
// which video ID is used to request it.
const YTCFG_PROBE_VIDEO_ID = 'jNQXAC9IVRw'; // "Me at the zoo"
const YTCFG_FETCH_TIMEOUT_MS = 15000;

/**
 * Extracts the ytcfg.set({...}) blob embedded in a YouTube watch page.
 * Needed for window.yt.config_ (see fetchYtConfig's caller) -- confirmed
 * necessary even when the attestation challenge itself comes from
 * innertube.getAttestationChallenge() rather than a page scrape: per
 * LuanRT (BgUtils author, quoted via FreeTubeApp/FreeTube#9607), BotGuard
 * validates an EVENT_ID field read from this config "together with the
 * embedded /att/get response OR doing your own /att/get request" --
 * i.e. it applies to both paths, not just the HTML-scrape one. bgutils-js
 * v4.0.3 (the version installed here) updated its own official Node.js
 * example to extract this same ytcfg from the page for the same reason.
 *
 * Brace-matching here is string-literal-aware (tracks quote state,
 * honors backslash-escapes) -- a naive counter previously misfired on a
 * quoted field containing a literal brace character; see git history /
 * prior incident for the concrete failure this caused.
 */
async function fetchYtConfig(videoId = YTCFG_PROBE_VIDEO_ID) {
  const res = await fetchWithTimeout(
    `https://www.youtube.com/watch?v=${videoId}`,
    { headers: { 'User-Agent': DESKTOP_CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9' } },
    YTCFG_FETCH_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new Error(`fetchYtConfig: watch page fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  // ytcfg.set(...) appears multiple times on a watch page -- some calls
  // are the two-arg string form (e.g. ytcfg.set('EXPERIMENT_FLAGS', ...)),
  // not the single-object form we want. A plain indexOf(marker) can lock
  // onto one of those and then indexOf('{', idx) skips forward past it
  // to an unrelated object elsewhere on the page (confirmed: it was
  // landing on the window.yterr error-boilerplate block). Require the
  // '{' to be the next non-whitespace character after the marker, and
  // advance to subsequent occurrences otherwise.
  const marker = 'ytcfg.set(';
  let searchFrom = 0;
  let start = -1;
  while (true) {
    const idx = html.indexOf(marker, searchFrom);
    if (idx === -1) {
      throw new Error('fetchYtConfig: could not find ytcfg.set({...}) (object form) in watch page HTML');
    }
    let i = idx + marker.length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] === '{') {
      start = i;
      break;
    }
    searchFrom = idx + marker.length;
  }

  let depth = 0;
  let inString = null; // null | '"' | "'"
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        const { parseLooseJSON } = await loadBgUtils();
        try {
          return parseLooseJSON(raw);
        } catch (err) {
          throw new Error(
            `fetchYtConfig: parseLooseJSON failed: ${err.message} ` +
            `(extracted ${raw.length} chars, head="${raw.slice(0, 80)}")`
          );
        }
      }
    }
  }
  throw new Error('fetchYtConfig: unterminated ytcfg block (brace depth never reached 0)');
}

/**
 * Builds ONE persistent jsdom window + BotGuardClient. This is the
 * expensive, ~120-160MB-RSS step -- callers must cache and reuse the
 * result, never call this per-token-mint. jim60105/bgutil-ytdlp-pot-
 * provider-rs CHANGELOG 0.5.4 documents exactly this mistake in an
 * earlier version of their own Rust BotGuard integration (new VM per
 * request -> ~25MB/request leak, 249MB growth over 10 requests).
 *
 * @param {import('youtubei.js').Innertube} innertube - a live Innertube
 *   instance, used only to call .getAttestationChallenge().
 */
async function createBotGuardInstance(innertube) {
  if (!innertube || typeof innertube.getAttestationChallenge !== 'function') {
    throw new Error(
      'createBotGuardInstance: expected a youtubei.js Innertube instance ' +
      '(with .getAttestationChallenge()), got something else'
    );
  }

  const { BotGuardClient } = await loadBgUtils();

  // Fetched in parallel -- independent network calls, both needed before
  // the interpreter can run correctly (see fetchYtConfig's doc comment
  // for why ytConfig is required even on this getAttestationChallenge()
  // path, not just a full HTML-scrape path).
  const [challengeResponse, ytConfig] = await Promise.all([
    innertube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND'),
    fetchYtConfig(),
  ]);
  const bgChallenge = challengeResponse?.bg_challenge;
  if (!bgChallenge) {
    throw new Error('createBotGuardInstance: getAttestationChallenge() returned no bg_challenge');
  }
  let interpreterUrl = bgChallenge.interpreter_url
    ?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  if (!interpreterUrl) {
    throw new Error('createBotGuardInstance: bg_challenge had no interpreter_url');
  }
  if (interpreterUrl.startsWith('//')) interpreterUrl = `https:${interpreterUrl}`;

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://www.youtube.com/',
    runScripts: 'dangerously',
    resources: new ResourceLoader({ userAgent: DESKTOP_CHROME_UA }),
  });
  const { window } = dom;

  // Real Chrome exposes window.chrome (runtime/loadTimes/csi -- a common
  // headless-detection check specifically looks for its absence) and
  // navigator.webdriver === false (jsdom leaves it undefined, which
  // real automation-controlled Chrome also sets to true -- undefined is
  // itself an atypical, non-real-browser value). Minimal stubs, not a
  // full emulation -- just closing gaps a basic check would notice.
  window.navigator.__defineGetter__('webdriver', () => false);
  window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };

  // BotGuard's interpreter reads its EVENT_ID (and other config) off
  // window.yt.config_ -- must be set BEFORE the interpreter script
  // executes. Confirmed required per LuanRT's own explanation (quoted
  // via FreeTubeApp/FreeTube#9607) and bgutils-js's own v4.0.3 example
  // update; see fetchYtConfig's doc comment.
  window.yt = { config_: ytConfig };

  const scriptRes = await fetchWithTimeout(
    interpreterUrl,
    { headers: { 'User-Agent': DESKTOP_CHROME_UA } },
    CHALLENGE_TIMEOUT_MS
  );
  if (!scriptRes.ok) {
    throw new Error(`createBotGuardInstance: interpreter script fetch failed: HTTP ${scriptRes.status}`);
  }
  const interpreterJavascript = await scriptRes.text();
  if (!interpreterJavascript) {
    throw new Error('createBotGuardInstance: interpreter script response was empty');
  }
  window.eval(interpreterJavascript);

  const botGuard = await BotGuardClient.create({
    program: bgChallenge.program,
    globalName: bgChallenge.global_name,
    globalObject: window,
  });

  return { dom, botGuard };
}

async function mintIntegrityToken(botGuardResponse) {
  const { buildURL, GOOG_API_KEY } = await loadBgUtils();
  const res = await fetchWithTimeout(
    buildURL('GenerateIT', true),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json+protobuf',
        'x-goog-api-key': GOOG_API_KEY,
        'x-user-agent': 'grpc-web-javascript/0.1',
        'User-Agent': DESKTOP_CHROME_UA,
      },
      body: JSON.stringify([REQUEST_KEY, botGuardResponse]),
    },
    CHALLENGE_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new Error(`mintIntegrityToken: GenerateIT failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  if (typeof data[0] !== 'string') {
    throw new Error(`mintIntegrityToken: unexpected GenerateIT response shape: ${JSON.stringify(data)}`);
  }
  return data[0];
}

// --- Persistent per-client_type instance cache -------------------------

// clientKey -> { instancePromise, createdAt }
// Keyed by a caller-supplied string (this file doesn't know about
// youtubei.js's ClientType enum -- innertube.js passes its own
// clientType label, e.g. 'WEB' / 'YTMUSIC').
const instances = new Map();

// BotGuard snapshots/integrity tokens aren't valid forever. Rebuild the
// whole VM instance (not just re-mint) past this age so a long-running
// process doesn't keep using a stale snapshot. jim60105's Rust provider
// added the equivalent (BotGuardClient::reinitialize(), CHANGELOG 0.6.0)
// after hitting exactly this with long-running processes.
const INSTANCE_TTL_MS = 4 * 60 * 60 * 1000; // 4h

async function getOrCreateInstance(clientKey, innertube) {
  const entry = instances.get(clientKey);
  const expired = !entry || Date.now() - entry.createdAt > INSTANCE_TTL_MS;
  if (entry?.instancePromise && !expired) {
    return entry.instancePromise;
  }
  const instancePromise = createBotGuardInstance(innertube).catch((err) => {
    // Don't cache a failed build -- next call should retry, not keep
    // returning the same rejected promise forever.
    instances.delete(clientKey);
    throw err;
  });
  instances.set(clientKey, { instancePromise, createdAt: Date.now() });
  return instancePromise;
}

/**
 * Mints a PO token for the given content binding (a visitor_data string
 * for session-bound tokens, or a video ID for content-bound tokens --
 * same contract as before).
 *
 * @param {string} contentBinding
 * @param {import('youtubei.js').Innertube} innertube - a live Innertube
 *   instance, used to fetch the attestation challenge.
 * @param {{ clientKey?: string, bypassCache?: boolean }} [opts] -
 *   clientKey selects which persistent BotGuard instance to use/build
 *   (defaults to a single shared instance). bypassCache forces a full
 *   rebuild of that instance (fresh challenge + fresh VM) instead of
 *   reusing the cached one -- use for refetch/retry after a rejected
 *   token, same as the old bgutil-rust bypass_cache semantics.
 * @returns {Promise<string>} po_token
 */
async function getPoToken(contentBinding, innertube, { clientKey = 'default', bypassCache = false } = {}) {
  if (!contentBinding) {
    throw new Error('getPoToken: contentBinding is required');
  }
  const { WebPoMinter } = await loadBgUtils();
  if (bypassCache) {
    instances.delete(clientKey);
  }
  const { botGuard } = await getOrCreateInstance(clientKey, innertube);

  const webPoSignalOutput = [];
  const botGuardResponse = await botGuard.snapshot({ webPoSignalOutput }, SNAPSHOT_TIMEOUT_MS);
  const integrityToken = await mintIntegrityToken(botGuardResponse);
  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  const token = await minter.mintAsWebsafeString(contentBinding);

  log.debug(
    'potProvider',
    `minted ${tokenFingerprint(token)} for content_binding tail=…${contentBinding.slice(-6)} ` +
    `(clientKey=${clientKey}${bypassCache ? ', cache bypassed' : ''})`
  );
  return token;
}

module.exports = { getPoToken };
