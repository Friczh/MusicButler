'use strict';

// Self-managed PO token / BotGuard attestation provider, in-process.
// Replaces the bgutil-rust HTTP sidecar with a direct integration of
// LuanRT/BgUtils (bgutils-js) + jsdom, following the same flow FreeTube
// ships in src/botGuardScript.js (verified against the live file on
// FreeTube's development branch, confirmed working with current YouTube
// as of writing).
//
// Flow, per client_type ('WEB' | 'YTMUSIC'):
//   1. Fetch the YouTube watch page HTML for a throwaway video ID, and
//      extract the embedded initial attestation data (window.ytAtR= or
//      the newer window.ytAtN(...) call) plus ytcfg (window.ytcfg.set).
//      This step exists because BotGuard now validates an EVENT_ID field
//      it reads off `window.yt.config_` -- that field only appears in
//      the watch-page's ytcfg blob, not in any InnerTube API response.
//      (See jim60105/bgutil-ytdlp-pot-provider-rs CHANGELOG 0.7.2 and
//      FreeTube PR #9607 -- both independently had to add this.)
//   2. Load the BotGuard interpreter script into a jsdom `window`, with
//      `window.yt = { config_: ytConfig }` set BEFORE execution.
//   3. BotGuardClient.create() + .snapshot() -> BotGuard response.
//   4. POST the BotGuard response + a fixed public requestKey to
//      Google's GenerateIT endpoint -> integrity token.
//   5. WebPoMinter.create() with the integrity token -> mintCallback.
//   6. mintCallback(contentBinding) -> PO token, base64.
//
// IMPORTANT (memory): steps 2-3 build a jsdom `window` + BotGuard VM,
// which has a real, fixed ~120-160MB RSS cost (benchmarked locally: bare
// node ~40MB -> +jsdom window ~160MB). That cost must be paid ONCE per
// client_type, not per token mint -- jim60105/bgutil-ytdlp-pot-provider-rs
// CHANGELOG 0.5.4 documents exactly this mistake in an earlier version of
// their own Rust BotGuard integration (new VM per request -> ~25MB/request
// leak, 249MB growth over 10 requests). This file keeps ONE persistent
// BotGuardClient per client_type, reused for every mint, matching the fix
// that changelog entry describes ("persistent worker thread pattern").
// Verified locally: repeated mints against one reused jsdom window show
// flat RSS, no growth.

const { JSDOM } = require('jsdom');
const { log } = require('./log');

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
    }));
  }
  return bgUtilsModulesPromise;
}

// Public, well-known YouTube web client requestKey. Same constant used by
// LuanRT/BgUtils issues, jim60105's Rust config default, and FreeTube's
// botGuardScript.js. Not a secret -- it identifies the *client type*
// (WEB) to Google's attestation service, not a per-user credential.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

const WATCH_PAGE_TIMEOUT_MS = 15000;
const CHALLENGE_TIMEOUT_MS = 15000;
const SNAPSHOT_TIMEOUT_MS = 10000;

// A stable, innocuous video ID used only to fetch a watch page for its
// embedded attestation/ytcfg data. The content itself is irrelevant --
// only the page's embedded config matters, and that config is the same
// regardless of which video ID is used to request it.
const WATCH_PAGE_PROBE_VIDEO_ID = 'jNQXAC9IVRw'; // "Me at the zoo"

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

// --- Step 1: watch-page scrape for initial attestation + ytcfg --------

/**
 * Extracts a top-level `var name = <value>;` or `name.set(<value>)` JSON
 * blob from raw HTML. YouTube's watch page embeds several of these as
 * inline <script> tags; this is a plain string scan (no HTML parser
 * needed), matching how the same data is extracted elsewhere in this
 * codebase's style (regex over known literal markers, not a DOM parse of
 * the whole page).
 */
function extractInlineJson(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch (err) {
          throw new Error(`extractInlineJson: found "${marker}" but JSON.parse failed: ${err.message}`);
        }
      }
    }
  }
  return null;
}

/**
 * Extracts the initial BotGuard attestation challenge embedded in the
 * watch page. YouTube has used two formats (confirmed against
 * jim60105/bgutil-ytdlp-pot-provider-rs CHANGELOG 0.7.2 and FreeTube's
 * botGuardScript.js, which handle both):
 *   - legacy: window.ytAtR = {...};
 *   - current: window.ytAtN({...});  (function-call form)
 * Both wrap the same shape used by botGuardScript.js as
 * `initialAttestationData`, with `.R` (bgChallenge) and `.T` (eacrToken).
 */
function extractInitialAttestation(html) {
  for (const marker of ['window.ytAtN(', 'window.ytAtR =', 'window.ytAtR=']) {
    const data = extractInlineJson(html, marker);
    if (data) return data;
  }
  return null;
}

function extractYtConfig(html) {
  // ytcfg.set({...}) is the standard embed; take the first (largest)
  // occurrence, which is the full config blob near the top of <head>.
  return extractInlineJson(html, 'ytcfg.set(');
}

async function fetchWatchPageAttestationData(videoId = WATCH_PAGE_PROBE_VIDEO_ID) {
  const res = await fetchWithTimeout(
    `https://www.youtube.com/watch?v=${videoId}`,
    {
      headers: {
        // A plausible desktop UA -- BotGuard/YouTube's watch-page
        // rendering path can differ (or omit the attestation embed
        // entirely) for unrecognized/bot-flagged user agents.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    WATCH_PAGE_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new Error(`fetchWatchPageAttestationData: watch page fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const initialAttestationData = extractInitialAttestation(html);
  const ytConfig = extractYtConfig(html);
  if (!initialAttestationData?.R?.bgChallenge) {
    throw new Error(
      'fetchWatchPageAttestationData: could not find window.ytAtN/ytAtR bgChallenge in watch page HTML ' +
      '(YouTube may have changed the embed format again)'
    );
  }
  if (!ytConfig) {
    throw new Error('fetchWatchPageAttestationData: could not find ytcfg.set(...) in watch page HTML');
  }
  return { initialAttestationData, ytConfig };
}

// --- Step 2-5: BotGuard VM load + snapshot + integrity token ----------

/**
 * Resolves the interpreter script URL + BotGuard program, falling back to
 * InnerTube's att/get endpoint (with the eacrToken from the watch-page
 * scrape) if the initial embed didn't include an interpreter URL inline
 * -- mirrors botGuardScript.js's fallback exactly.
 */
async function resolveChallenge(initialAttestationData, context) {
  let challengeData = initialAttestationData.R;
  let interpreterUrl = challengeData?.bgChallenge?.interpreterUrl
    ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;

  if (!interpreterUrl) {
    const res = await fetchWithTimeout(
      'https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false&alt=json',
      {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
          'X-Goog-Visitor-Id': context.client.visitorData,
          'X-Youtube-Client-Version': context.client.clientVersion,
          'X-Youtube-Client-Name': '1',
        },
        body: JSON.stringify({
          engagementType: 'ENGAGEMENT_TYPE_UNBOUND',
          eacrToken: initialAttestationData.T,
          context,
        }),
      },
      CHALLENGE_TIMEOUT_MS
    );
    if (!res.ok) {
      throw new Error(`resolveChallenge: att/get failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }
    challengeData = await res.json();
    interpreterUrl = challengeData?.bgChallenge?.interpreterUrl
      ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  }

  if (!challengeData?.bgChallenge || !interpreterUrl) {
    throw new Error('resolveChallenge: failed to obtain a BotGuard challenge');
  }
  if (interpreterUrl.startsWith('//')) interpreterUrl = `https:${interpreterUrl}`;
  return { challengeData, interpreterUrl };
}

/**
 * Builds ONE persistent jsdom window + BotGuardClient for a client_type.
 * This is the expensive, ~120-160MB-RSS step -- callers must cache and
 * reuse the result, never call this per-token-mint. See the file-level
 * comment above for why.
 */
async function createBotGuardInstance(context) {
  const { BotGuardClient } = await loadBgUtils();
  const { initialAttestationData, ytConfig } = await fetchWatchPageAttestationData();
  const { challengeData, interpreterUrl } = await resolveChallenge(initialAttestationData, context);

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://www.youtube.com/',
    runScripts: 'dangerously',
  });
  const { window } = dom;

  // BotGuard reads its EVENT_ID (and other config) off window.yt.config_
  // -- this must be set BEFORE the interpreter script executes. This is
  // the fix both jim60105's Rust provider (CHANGELOG 0.7.2) and FreeTube
  // (PR #9607) had to add after YouTube started validating it.
  window.yt = { config_: ytConfig };

  const scriptRes = await fetchWithTimeout(interpreterUrl, {}, CHALLENGE_TIMEOUT_MS);
  if (!scriptRes.ok) {
    throw new Error(`createBotGuardInstance: interpreter script fetch failed: HTTP ${scriptRes.status}`);
  }
  const interpreterJavascript = await scriptRes.text();
  if (!interpreterJavascript) {
    throw new Error('createBotGuardInstance: interpreter script response was empty');
  }
  window.eval(interpreterJavascript);

  const botGuard = await BotGuardClient.create({
    program: challengeData.bgChallenge.program,
    globalName: challengeData.bgChallenge.globalName,
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

async function getOrCreateInstance(clientKey, context) {
  const entry = instances.get(clientKey);
  const expired = !entry || Date.now() - entry.createdAt > INSTANCE_TTL_MS;
  if (entry?.instancePromise && !expired) {
    return entry.instancePromise;
  }
  const instancePromise = createBotGuardInstance(context).catch((err) => {
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
 * @param {import('youtubei.js').Session['context']} context - innertube
 *   session context, used only if the initial watch-page embed lacks an
 *   inline interpreter URL and the att/get fallback is needed.
 * @param {{ clientKey?: string, bypassCache?: boolean }} [opts] -
 *   clientKey selects which persistent BotGuard instance to use/build
 *   (defaults to a single shared instance). bypassCache forces a full
 *   rebuild of that instance (fresh watch-page scrape + fresh VM) instead
 *   of reusing the cached one -- use for refetch/retry after a rejected
 *   token, same as the old bgutil-rust bypass_cache semantics.
 * @returns {Promise<string>} po_token
 */
async function getPoToken(contentBinding, context, { clientKey = 'default', bypassCache = false } = {}) {
  if (!contentBinding) {
    throw new Error('getPoToken: contentBinding is required');
  }
  const { WebPoMinter } = await loadBgUtils();
  if (bypassCache) {
    instances.delete(clientKey);
  }
  const { botGuard } = await getOrCreateInstance(clientKey, context);

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
