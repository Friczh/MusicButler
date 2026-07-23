# MusicButler-Worker + bundled bgutil-pot binary (Rust POT provider),
# so both run as ONE Render service instead of two separate accounts.
#
# LICENSE NOTE: bgutil-ytdlp-pot-provider-rs is GPLv3. Its own license text
# states that distributing an image which uses code from that repository
# may trigger GPL source-disclosure obligations. This Dockerfile downloads
# their pre-compiled release binary rather than building FROM their image,
# but bundling the binary itself into this image is still a form of
# distribution if you push this image anywhere. Not legal advice — confirm
# your obligations under GPLv3 before deploying this as-is.

FROM node:22-slim AS base

# --- fetch the prebuilt Rust POT binary (linux x86_64, matches Render's runners) ---
FROM base AS pot-binary
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN wget -q -O /usr/local/bin/bgutil-pot \
    https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-linux-x86_64 \
    && chmod +x /usr/local/bin/bgutil-pot

# --- final image ---
FROM base
WORKDIR /app

# ca-certificates: required at runtime for the POT binary's HTTPS calls to
# YouTube/Google (this apt-get was previously only done in the pot-binary
# build stage, which never ships — the final image inherited from `base`
# and had no CA bundle at all).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=pot-binary /usr/local/bin/bgutil-pot /usr/local/bin/bgutil-pot

# Smoke test: the release binary is built on ubuntu-latest (glibc can be
# newer than node:22-slim's Debian bookworm base). If it's incompatible,
# fail the build now with a clear error instead of crash-looping after
# deploy. If this fails, switch to a newer/matching base image or build
# bgutil-pot from source instead of using the release binary.
RUN /usr/local/bin/bgutil-pot --version

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ENV POT_SERVER_HOST=127.0.0.1
ENV POT_SERVER_PORT=4416

EXPOSE 8080

CMD ["./start.sh"]
