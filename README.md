# MusicButler

## What is it?

A self-hosted Discord music bot for playing audio from YouTube and YouTube Music. Runs as a single Node.js process in one Docker container.
|  Slash commands  ||
|---|---|
| `/play <query>` | Play a YouTube/YouTube Music URL or search query |
| `/skip` | Skip the current track |
| `/pause` / `/resume` | Pause / resume playback |
| `/leave` | Leave the voice channel and clear the queue |
| `/queue list` | Show the current queue |
| `/queue remove <position>` | Remove a track by its position |
| `/queue swap <position_a> <position_b>` | Swap two tracks |
| `/queue move <from> <to>` | Move a track to a new position |
| `/queue clear` | Clear the queue |

Auto-leaves a voice channel once every human member has left it. Built for single-guild use.

## How to download?

Clone the source code using this command
```bash
git clone https://github.com/Friczh/MusicButler
```

Pre-built images are also published to GHCR on every push to `main`. To run one instead of building locally, point `docker-compose.yml` at the image instead of `build: .`:

```yaml
services:
  musicbutler:
    image: ghcr.io/Friczh/MusicButler:latest
    env_file:
      - .env
    restart: unless-stopped
```

## How to build?

Requirements: Docker + Docker Compose.

1. Create `.env` file and fill in the required values (see **Config**) and put it in the same folder as `docker-compose.yml`
2. ```bash
   docker compose build --no-cache
   docker compose up -d
   ```
   Use `--no-cache` on rebuilds — `ffmpeg-static`/`bgutil-pot` aren't pinned to a lockfile hash, so a stale layer cache can keep an old binary around.
## Config

Set in `.env` (see `.env.example`).


| Variable |What it's for|
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal (Required) |
| `YOUTUBE_COOKIES_BASE64` | Base64-encoded YouTube cookies, used to authenticate audio requests. Accepts a raw `name=value; name2=value2` Cookie header string or a Netscape-format `cookies.txt` export, either base64-encoded.(Required) |

### Optional — buffering tuning

| Variable | Default |What it's for|
|---|---|---|
| `MB_PREBUFFER_SECONDS` | `1.5` | Seconds of audio buffered before playback starts. Higher = fewer stutters at track start, longer delay before audio begins. |
| `MB_NETWORK_BUFFER_MS` | `2000` | Buffer kept mid-track to absorb CDN jitter. |
| `MB_PREBUFFER_TIMEOUT_MS` | `8000` | Max wait for the prebuffer target before starting playback anyway. |
| `MB_ASSUMED_BITRATE_BPS` | `128000` | Fallback bitrate if a track's real bitrate is unavailable. |
| `MB_STALL_BUFFER_MS` | `400` | Opus-frame cushion between demuxing and Discord playback. |
| `MB_PLAYLIST_MAX_TRACKS` | `500` | Caps tracks pulled in from a single playlist add. Longer playlists are truncated. |

### Optional — Developer options

| Variable | Default | What it's for |
|---|---|---|
| `MB_HEALTH_ENABLED` | `false` | `true` starts an HTTP server: `200 ok` once connected to Discord, `503 starting` before. |
| `PORT` | `8080` | Port the health server binds to, if enabled. |
| `MB_VERBOSE` | `false` | `true` enables debug logging: Discord gateway/voice connection state, streaming/track lifecycle, periodic buffer-state snapshots. |

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Discord, YouTube, or Google.

Extracting audio from YouTube can be against YouTube's Terms of Service. `YOUTUBE_COOKIES_BASE64` grants access to whatever the source account can access — treat it as a credential. Do not use your main account. You are responsible for complying with the terms of service of any platform this bot interacts with, and applicable copyright law for the content you play. Use at your own risk; no warranty is provided.
