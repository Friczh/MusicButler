# syntax=docker/dockerfile:1

# PO tokens are now minted in-process via LuanRT/BgUtils (bgutils-js) +
# jsdom -- see src/lib/potProvider.js. No more bgutil-rust sidecar binary,
# no fetch stage, no start.sh, no POT_SERVER_*/POT_PROVIDER_URL env vars.
# The Node runtime itself makes the outbound calls (watch-page scrape,
# BotGuard interpreter fetch, GenerateIT), so no separate glibc-version
# constraint from a prebuilt Rust release binary applies here -- any
# node:*-bookworm-slim base works.
FROM node:20-bookworm-slim AS final

# ca-certificates -- potProvider.js's own HTTPS calls to youtube.com /
# googleapis.com need this, same as before.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# --legacy-peer-deps: prism-media@1.3.5 lists opusscript@^0.0.8 as an
# OPTIONAL peer dependency (peerDependenciesMeta.opusscript.optional:
# true, confirmed in installed prism-media/package.json), but npm's
# ERESOLVE check still hard-fails on version mismatches for optional
# peers regardless -- long-standing npm behavior, not a bug in this
# setup. opusscript@0.1.1 (see buildTranscodedOpusPipeline() in
# demuxPipeline.js) is confirmed working against prism-media's loader
# (which just does a plain `require('opusscript')` + duck-typed API
# check, not a semver check) via a real end-to-end AAC transcode test
# -- so the fix here is telling npm to ignore the stale peer range,
# not downgrading a version we've verified works.
RUN npm ci --omit=dev --legacy-peer-deps || npm install --omit=dev --legacy-peer-deps

COPY src ./src
COPY assets ./assets

# Same rationale as before, for the ffmpeg-static binary `npm ci` above
# just fetched via its postinstall script (used only for the SABR
# non-Opus/AAC transcode fallback -- see src/lib/demuxPipeline.js's
# buildTranscodedOpusPipeline()). ffmpeg-static ships a static, self-
# contained Linux x86_64 binary, so this should never actually fail on
# this base image, but it's a one-line check against a silent failure
# mode being deferred to the first AAC-only track someone actually queues.
RUN ffmpeg_bin="$(node -e "console.log(require('ffmpeg-static'))")" && "$ffmpeg_bin" -version

ENV NODE_ENV=production
# Render injects its own PORT at runtime and overrides this -- this is just
# the fallback health.js uses when PORT isn't set (e.g. local/friend's-host
# runs, where nothing is listening on it anyway).
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["node", "src/index.js"]
