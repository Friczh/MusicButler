'use strict';

const { Readable } = require('node:stream');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const { getSession, getSabrClientInfo } = require('./innertube');
const { getPoToken } = require('./potProvider');
const { buildSabrAudioStream } = require('./sabr');
const { PrebufferTransform } = require('./prebuffer');
const { buildOpusPipeline, buildTranscodedOpusPipeline } = require('./demuxPipeline');
const { config, OPUS_FRAME_MS } = require('./config');
const { log } = require('./log');
const { repostPanel, editPanelInPlace } = require('./panel');
const { clearBotMessages } = require('./messageCleanup');

// SabrStream throws this exact message when the server requires
// attestation (a bot-check/DRM gate) this bot can't satisfy -- worth a
// distinct log line, even though the handling (skip the track) is the same.
function isAttestationRequired(err) {
  return /attestation required/i.test(err?.message || '');
}

function describeStreamError(err, usedSabr) {
  if (usedSabr && isAttestationRequired(err)) {
    return 'SABR attestation required -- YouTube is requiring additional client verification ' +
      'this bot cannot satisfy for this video (DRM/bot-check gate), not a network or pipeline bug';
  }
  return err.message;
}

class GuildPlayer {
  constructor(guildId, queue, client, onIdleTimeout = null) {
    this.guildId = guildId;
    this.queue = queue;
    // Needed for panel.js/messageCleanup.js, which operate on the text
    // channel independent of the voice connection.
    this.client = client;
    // Called when either timer below fires -- set by PlayerManager to a
    // closure that fully tears the player down AND removes it from
    // PlayerManager's map (disconnect() alone only handles the
    // connection/queue side, same as it always has for /leave etc.).
    this._onIdleTimeout = onIdleTimeout;
    this.connection = null;
    this.audioPlayer = createAudioPlayer();
    // abort() hook for the current SABR track (null if none/direct-URL).
    // Destroying the Node stream alone doesn't stop SabrStream's
    // background fetch loop -- only .abort() on the instance does.
    this._activeAbort = null;
    // Set by skip(), read/cleared by the Idle listener -- lets _playNext()
    // tell a manual skip apart from a natural end (matters for repeat-one).
    this._pendingManualSkip = false;
    // True while we're holding audioPlayer.pause() during a SABR
    // reconnect, to dodge @discordjs/voice's 5-missed-frame (100ms)
    // kill-switch. Only auto-unpause if WE set this -- never override a
    // user's own /pause.
    this._pausedForReconnect = false;
    // "Alone in VC" timer, independent of _idleTimer below (see
    // handleVoicePopulationChange()).
    this._aloneTimer = null;
    // "Nothing playing" timer -- see _startIdleTimer()/_clearIdleTimer().
    this._idleTimer = null;
    this._wireAudioPlayerEvents();
  }

  _wireAudioPlayerEvents() {
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      const manualSkip = this._pendingManualSkip;
      this._pendingManualSkip = false;
      this._playNext({ manualSkip }).catch((err) =>
        console.error(`[player:${this.guildId}] playNext failed:`, err.message)
      );
    });
    this.audioPlayer.on('error', (err) => {
      console.error(`[player:${this.guildId}] audio player error:`, err.message);
      // isError: true -- never honor repeat-one/repeat-all for a track
      // that just failed, or a bad track would retry (repeat-one) or
      // keep cycling back around (repeat-all) forever. Same reasoning as
      // the "don't let one bad track wedge the queue" comment below.
      this._playNext({ isError: true }).catch((e) =>
        console.error(`[player:${this.guildId}] playNext after error failed:`, e.message)
      );
    });
    // Current streaming state -- every status transition the AudioPlayer
    // goes through (Idle <-> Buffering <-> Playing, AutoPaused when nobody's
    // subscribed, Paused via /pause). oldState.status/newState.status are
    // AudioPlayerStatus strings.
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      log.debug(`player:${this.guildId}`, `audio player ${oldState.status} -> ${newState.status}`);
    });
  }

  // --- Auto-exit timers -------------------------------------------------
  // Two independent timers, sharing one configured duration
  // (config.idleTimeoutMin) but never resetting/cancelling each other.
  // Whichever fires first tears the whole player down.

  _fireTimeout(reason) {
    this._clearAloneTimer();
    this._clearIdleTimer();
    log.debug(`player:${this.guildId}`, `auto-exit: ${reason} timeout elapsed`);
    this._onIdleTimeout?.();
  }

  _startAloneTimer() {
    if (this._aloneTimer || config.idleTimeoutMin <= 0) return;
    this._aloneTimer = setTimeout(() => this._fireTimeout('alone'), config.idleTimeoutMin * 60_000);
  }

  _clearAloneTimer() {
    if (!this._aloneTimer) return;
    clearTimeout(this._aloneTimer);
    this._aloneTimer = null;
  }

  _startIdleTimer() {
    if (this._idleTimer || config.idleTimeoutMin <= 0) return;
    // Repeat (either mode) means "keep this going" -- the idle auto-exit
    // doesn't apply while it's on, otherwise a countdown started before
    // repeat was enabled (an earlier pause/drain) could fire mid-loop and
    // tear the whole player down out from under active playback. The
    // alone-in-VC timer is unaffected -- that's a population concern,
    // not a playback one, and still applies regardless of repeat mode.
    if (this.queue.repeatMode !== 'off') return;
    this._idleTimer = setTimeout(() => this._fireTimeout('idle'), config.idleTimeoutMin * 60_000);
  }

  _clearIdleTimer() {
    if (!this._idleTimer) return;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  /**
   * Called from index.js's voiceStateUpdate handler on any population
   * change in the bot's voice channel. `isEmpty` = no humans remain.
   * On rejoin, clears BOTH timers -- not just the alone one -- so a
   * silent rejoin (no explicit Resume) can't still get auto-kicked by a
   * leftover idle countdown.
   */
  handleVoicePopulationChange(isEmpty) {
    if (isEmpty) {
      if (this._aloneTimer) return; // already counting down
      this.pause();
      this._startAloneTimer();
    } else {
      // Cancelled, not resumed -- playback stays paused until someone
      // explicitly hits Resume/Play. Both timers are reset here so
      // rejoining fully clears any pending auto-exit, not just the
      // alone-specific one.
      this._clearAloneTimer();
      this._clearIdleTimer();
    }
  }


  async connect(voiceChannel) {
    log.debug(`player:${this.guildId}`, `joining voice channel ${voiceChannel.id}`);
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    // Logs every voice connection state hop (Signalling/Connecting/Ready/Disconnected).
    this.connection.on('stateChange', (oldState, newState) => {
      log.debug(`player:${this.guildId}`, `voice connection ${oldState.status} -> ${newState.status}`);
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    log.debug(`player:${this.guildId}`, 'voice connection ready');
    this.connection.subscribe(this.audioPlayer);
  }

  disconnect() {
    this._clearAloneTimer();
    this._clearIdleTimer();
    // Fire-and-forget: cleans up every bot message in the text channel
    // (including the panel itself) on VC leave. Uses queue.textChannelId,
    // which is NOT cleared by queue.clear() below, so it's still valid at
    // this point. Errors are logged inside clearBotMessages, not thrown.
    if (this.client && this.queue.textChannelId) {
      clearBotMessages(this.client, this.queue.textChannelId).catch((err) =>
        log.error(`player:${this.guildId}`, `panel cleanup on disconnect failed: ${err.message}`)
      );
    }
    this.queue.panelMessageId = null;
    this.queue.bumpGeneration();
    this.queue.clear();
    this.audioPlayer.stop(true);
    this.connection?.destroy();
    this.connection = null;
  }

  /** Add a track to the queue; kicks off playback if nothing is playing. */
  async enqueue(track) {
    this.queue.add(track);
    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle && !this.queue.playing) {
      await this._playNext();
    } else {
      // Something's already playing -- edit the panel's "up next" count
      // in place rather than reposting (repost is reserved for actual
      // track changes). Skip entirely for a silent track (freenitro
      // easter egg) -- it must not surface anywhere.
      if (!track.silent) this._updatePanelInPlace();
    }
  }

  /** Batch version of enqueue(), for playlists — one idle-check, not N. */
  async enqueueMany(tracks) {
    if (tracks.length === 0) return;
    this.queue.addMany(tracks);
    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle && !this.queue.playing) {
      await this._playNext();
    } else if (!tracks.every((t) => t.silent)) {
      this._updatePanelInPlace();
    }
  }

  /**
   * Snapshots the abort handle for whatever is CURRENTLY playing (if
   * SABR-delivered). Must be called before prepareResource() for a
   * different track -- building that track's resource can overwrite
   * this._activeAbort as a side effect (see applySabr() inside
   * _buildResource()), which would otherwise lose the outgoing track's
   * handle before it's ever cleaned up.
   */
  snapshotActiveAbort() {
    return this._activeAbort;
  }

  /** Builds a playable resource for `track` without touching queue/audioPlayer, so it can be built ahead of time and swapped in via swapInPrebuilt(). */
  async prepareResource(track) {
    return this._buildResource(track);
  }

  /**
   * Swaps an already-built `resource` into playback immediately.
   * `.play()` goes straight Playing -> Playing (no intermediate Idle),
   * so this can't race the Idle listener. Whatever was playing is pushed
   * back to the front of the queue to replay from the start after.
   * @param outgoingAbort - snapshotActiveAbort()'s value, captured
   *   BEFORE prepareResource() ran for `track`.
   */
  swapInPrebuilt(track, resource, outgoingAbort) {
    if (outgoingAbort) {
      try {
        outgoingAbort();
      } catch { /* already finished/aborted -- nothing to clean up */ }
    }

    if (this.queue.playing) this.queue.addFront(this.queue.playing);
    this.queue.playing = track;
    // Invalidates any unrelated in-flight _playNext() extraction (e.g. a
    // skip() that happened to fire around the same moment) so it can't
    // land after this swap and clobber it.
    this.queue.bumpGeneration();
    this._clearIdleTimer();
    this.audioPlayer.play(resource);
  }

  /** Fire-and-forget edit-in-place panel refresh; errors are logged, not thrown. */
  _updatePanelInPlace() {
    if (!this.client) return;
    editPanelInPlace(this.client, this.queue, { isPaused: this.isPaused() }).catch((err) =>
      log.error(`player:${this.guildId}`, `panel edit failed: ${err.message}`)
    );
  }

  /** Wraps queue.setRepeatMode(), also clearing any idle timer that started before repeat was turned on. */
  setRepeatMode(mode) {
    const applied = this.queue.setRepeatMode(mode);
    if (applied !== 'off') this._clearIdleTimer();
    return applied;
  }

  cycleRepeatMode() {
    const applied = this.queue.cycleRepeatMode();
    if (applied !== 'off') this._clearIdleTimer();
    return applied;
  }

  /** Public -- used by commands (e.g. /repeat) that change queue state without an interaction bound to the panel message itself. */
  refreshPanel() {
    this._updatePanelInPlace();
  }

  /** Public -- used by panelInteractions.js's pause/resume toggle button. */
  isPaused() {
    return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  skip() {
    // Invalidate any in-flight extraction for the current track first, so a
    // slow resolve that finishes after this call can't clobber whatever the
    // Idle handler starts next.
    this.queue.bumpGeneration();
    // Read by the Idle listener -- a manual skip always advances past
    // repeat-one instead of replaying the current track.
    this._pendingManualSkip = true;
    this.audioPlayer.stop(true);
  }

  pause() {
    const ok = this.audioPlayer.pause();
    if (ok) {
      this._startIdleTimer();
      this._updatePanelInPlace();
    }
    return ok;
  }

  resume() {
    const ok = this.audioPlayer.unpause();
    if (ok) {
      this._clearIdleTimer();
      this._updatePanelInPlace();
    }
    return ok;
  }

  /** SABR reconnect start (sabr.js onReconnectStart). Only pauses/sets the flag if actually Playing -- must not claim credit for a user's own /pause. */
  _pauseForReconnect() {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      this.audioPlayer.pause();
      this._pausedForReconnect = true;
    }
  }

  /** Called from sabr.js's onReconnectEnd (success or final give-up alike -- see sabr.js). */
  _unpauseAfterReconnect() {
    if (!this._pausedForReconnect) return;
    this._pausedForReconnect = false;
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      this.audioPlayer.unpause();
    }
  }

  /** Stops the outgoing track's SABR fetch loop, if any. Best-effort -- abort() can throw on an already-closed stream, swallowed. */
  _abortActiveSabr() {
    const abort = this._activeAbort;
    this._activeAbort = null;
    if (!abort) return;
    try {
      abort();
    } catch { /* already finished/aborted -- nothing to clean up */ }
  }

  async _playNext({ manualSkip = false, isError = false } = {}) {
    // Always stop the previous track's SABR fetch loop first, regardless of why we're here.
    this._abortActiveSabr();

    const finished = this.queue.playing;
    let track;

    if (finished && !finished.silent && this.queue.repeatMode === 'one' && !manualSkip && !isError) {
      // Repeat-one, and this wasn't a manual skip or a failure -- replay
      // the same track object instead of pulling from the queue. Always
      // re-extracted from scratch (no seek/position tracking anywhere in
      // this codebase), same as a normal replay.
      track = finished;
    } else {
      if (isError) {
        // Don't let a track that just failed to play end up in
        // repeat-all's history -- queue.next() records whatever is
        // currently `playing` into history, so detaching the reference
        // here (not clearing the queue, just this one pointer) keeps a
        // broken track from eventually cycling back around and failing
        // again, forever.
        this.queue.playing = null;
      }
      // Repeat-all's "loop the whole queue" behavior lives inside
      // queue.next() itself now (it records finished tracks into
      // history and refills from there once `tracks` runs dry) --
      // nothing extra to do here for that case.
      track = this.queue.next();
    }

    if (!track) {
      // Queue drained -- reflect idle state on the panel in place (not a
      // track change, so no repost), and start the idle auto-exit timer
      // (see _startIdleTimer() -- no-ops if already running or disabled).
      this._startIdleTimer();
      this._updatePanelInPlace();
      return;
    }

    const generation = this.queue.generation;
    let resource;
    const buildStartedAt = Date.now();
    try {
      resource = await this._buildResource(track);
    } catch (err) {
      // Logged with the videoId and elapsed time specifically so a
      // MB_VERBOSE capture of a reported "disconnect loop" can be read back
      // and answered definitively: is this the SAME videoId failing
      // repeatedly (queue.next() with repeat-all eventually cycling back
      // to a track that always fails attestation/SABR for this
      // account/IP), or a DIFFERENT videoId every time (a systemic
      // session/token/network problem, not a per-video one)?
      console.error(
        `[player:${this.guildId}] extraction failed for ${track.videoId} ` +
        `after ${Date.now() - buildStartedAt}ms:`, err.message
      );
      if (this.queue.isCurrentGeneration(generation)) {
        return this._playNext({ isError: true }); // don't let one bad track wedge the queue
      }
      return;
    }

    if (!this.queue.isCurrentGeneration(generation)) return; // stale result, drop it

    log.debug(`player:${this.guildId}`, `now playing ${track.videoId}`);
    this._clearIdleTimer();
    this.audioPlayer.play(resource);

    // Track change: repost the panel at the bottom of the channel (not edit-in-place). Skipped for silent/easter-egg tracks.
    if (this.client && !track.silent) {
      repostPanel(this.client, this.queue, { isPaused: false }).catch((err) =>
        log.error(`player:${this.guildId}`, `panel repost failed: ${err.message}`)
      );
    }
  }

  /** Logs streaming_data/format/CDN detail when both direct and SABR acquisition fail, so it's diagnosable from logs alone. */
  async _logStreamFailureDiagnostic(track, info, format, directErr, sabrErr = null) {
    const sd = info.streaming_data || {};
    let cdnDetail = '';
    if (directErr.info?.response) {
      const r = directErr.info.response;
      let bodyText = '';
      try { bodyText = (await r.clone().text()).slice(0, 300); } catch { /* ignore */ }
      cdnDetail = `\n  CDN response status: ${r.status} ${r.statusText}\n  CDN response body (first 300 chars): ${bodyText}`;
    }
    console.warn(
      `[player:${this.guildId}] STREAM-ACQUISITION-DIAGNOSTIC for ${track.videoId}:\n` +
      `  direct error message: ${directErr.message}\n` +
      `  direct error_type: ${directErr.info?.error_type}\n` +
      (sabrErr ? `  sabr fallback error: ${sabrErr.message}\n` : '  sabr fallback: not attempted (no server_abr_streaming_url)\n') +
      `  streaming_data keys: ${JSON.stringify(Object.keys(sd))}\n` +
      `  has server_abr_streaming_url: ${!!sd.server_abr_streaming_url}\n` +
      `  chosen format keys: ${JSON.stringify(Object.keys(format))}\n` +
      `  format.has_audio: ${format.has_audio}, format.itag: ${format.itag}, ` +
      `format.mime_type: ${format.mime_type}\n` +
      `  format has url/cipher: url=${!!format.url}, signature_cipher=${!!format.signature_cipher}, cipher=${!!format.cipher}` +
      cdnDetail
    );
  }

  /**
   * Direct-URL acquisition: the path youtubei.js's own info.download() can
   * resolve without SABR. Throws "No valid URL to decipher" synchronously
   * (before any network fetch) when the chosen format is SABR-only.
   */
  async _acquireDirect(track, info, format) {
    const webStream = await info.download({
      type: 'audio',
      format: 'webm',
      quality: 'best',
    });
    log.debug(`player:${this.guildId}`, `${track.videoId}: direct-URL acquisition succeeded, itag ${format.itag}, ${format.bitrate}bps`);
    return Readable.fromWeb(webStream);
  }

  /**
   * SABR acquisition via googlevideo's SabrStream. Returns the node
   * stream, actual selected format (may differ from `format`), whether
   * it needs an FFmpeg transcode (non-Opus), and the abort hook.
   */
  async _acquireSabr(track, info, session, format, poToken) {
    const clientInfo = getSabrClientInfo(session, track.isMusic ? 'YTMUSIC' : 'WEB');
    const { audioStream: sabrWebStream, format: sabrFormat, abort } = await buildSabrAudioStream(
      info,
      session,
      clientInfo,
      poToken,
      {
        preferredItag: format.itag,
        // Lets sabr.js reconnect transparently on a recoverable failure
        // (reload, stale video-bound token) instead of ending the track.
        refetchInfo: () => (
          track.isMusic ? session.music.getInfo(track.videoId) : session.getInfo(track.videoId)
        ),
        // Re-mints the VIDEO-bound token (distinct from the session token
        // set in _buildResource) -- fixes the stale-token case. bypassCache
        // rebuilds the shared BotGuard instance from scratch (fresh
        // watch-page scrape + fresh VM) instead of reusing the cached
        // one; without it, a rejected/stale snapshot just keeps minting
        // the same already-rejected token and the attestation-pending
        // loop never breaks.
        refetchPoToken: () => getPoToken(track.videoId, session.session.context, { bypassCache: true }),
        onReconnectStart: () => this._pauseForReconnect(),
        onReconnectEnd: () => this._unpauseAfterReconnect(),
      }
    );
    log.debug(`player:${this.guildId}`, `${track.videoId}: SABR acquisition succeeded, itag ${sabrFormat.itag}, mimeType ${sabrFormat.mimeType}`);
    const needsTranscode = !sabrFormat.mimeType?.includes('opus');
    if (needsTranscode) {
      console.warn(
        `[player:${this.guildId}] SABR selected a non-Opus format for ${track.videoId} ` +
        `(itag ${sabrFormat.itag}, mimeType "${sabrFormat.mimeType}"); transcoding via FFmpeg`
      );
    }
    return { nodeStream: Readable.fromWeb(sabrWebStream), format: sabrFormat, abort, needsTranscode };
  }

  async _buildResource(track) {
    // Defensive reset -- a previous track's abort mid-reconnect could
    // leave this stuck true otherwise.
    this._pausedForReconnect = false;
    // Session client_type must match the track (WEB vs YTMUSIC) -- a
    // token minted for one isn't valid for the other. See innertube.js.
    const session = await getSession({ clientType: track.isMusic ? 'YTMUSIC' : 'WEB' });
    // The *method* matters too, not just client_type: session.getInfo()
    // always casts to a plain-YouTube shape and throws on a YTM response.
    // session.music.getInfo() is the one that handles YTM's shape and
    // still uses the session's YTMUSIC-bootstrapped token internally.
    //
    // NOTE: youtubei.js commonly logs a "[YOUTUBEJS][Parser]: ParsingError:
    // Type mismatch..." warning here for videos with newer UI panels
    // (e.g. the "Ask"/AI sidebar) that this library version doesn't have a
    // parser class for yet. That's harmless — youtubei.js's default error
    // handler only warns and returns null for that one panel, it doesn't
    // throw (confirmed against parser.js source: the 'typecheck' case in
    // ERROR_HANDLER never throws). getInfo() still completes normally and
    // still returns valid streaming_data. Don't treat it as a failure.
    const info = track.isMusic
      ? await session.music.getInfo(track.videoId)
      : await session.getInfo(track.videoId);

    // chooseFormat() throws (never returns null) when there's no match --
    // wrapped only to identify which track failed.
    let format;
    try {
      format = info.chooseFormat({ type: 'audio', format: 'webm', quality: 'best' });
    } catch (err) {
      throw new Error(`No suitable audio-only webm/opus format found for ${track.videoId}: ${err.message}`);
    }

    // GVS (the CDN media fetch) needs a PO token bound to the VIDEO ID,
    // not the session/visitor_data one used for getInfo/search. Without
    // it the CDN rejects the fetch with 403.
    //
    // decipher() has no per-call token override -- it reads whatever's
    // currently on session.player.po_token, so it must be set here first.
    // (`session.session.player`, not `session.player` -- the Innertube
    // wrapper only exposes the real Session via the `.session` getter.)
    //
    // CONCURRENCY CAVEAT: session.player is shared globally per
    // client_type across all guilds. Mutating po_token here isn't safe
    // under concurrent multi-guild playback (not a concern for this
    // single-guild deployment) -- would need a per-download token
    // override instead of mutating shared state.
    const poToken = await getPoToken(track.videoId, session.session.context);
    // Diagnostic: confirms the session and video-bound tokens are
    // actually distinct values, rather than assuming it.
    log.debug(
      'player',
      `${track.videoId}: session po_token before overwrite: len=${session.session.player.po_token?.length ?? 0}, ` +
      `video-bound po_token: len=${poToken?.length ?? 0}, identical=${session.session.player.po_token === poToken}`
    );
    session.session.player.po_token = poToken;

    // PHASE 1: acquire a raw webm/opus byte stream, direct-URL first,
    // falling back to SABR (googlevideo's SabrStream — see sabr.js) if
    // that fails. Two genuinely different failure shapes land here:
    //   - "No valid URL to decipher" thrown synchronously from INSIDE
    //     download() itself, before any network fetch — the chosen
    //     format has no direct url/signature_cipher/cipher at all.
    //   - An async CDN-fetch rejection (e.g. 403) surfaced through the
    //     awaited download() call, as seen in production
    //     (SABR-DIAGNOSTIC: error_type FETCH_FAILED, CDN 403).
    // Both are format/session/CDN-state failures unrelated to whether
    // SABR delivery is available for this video, so both trigger the
    // same fallback check below.
    let nodeStream;
    let usedSabr = false;
    // The format ACTUALLY being streamed, used below for prebuffer sizing.
    // NOT always `format` -- SABR fallback may pick a different itag/
    // bitrate than the direct-download pick (chooseAudioFormat() falls
    // back when the preferred itag isn't SABR-eligible). Sizing the
    // prebuffer off the wrong bitrate here was the root cause of the
    // SABR-specific stutter/speedup reports.
    let streamFormat = format;
    // Only meaningful when usedSabr: whether the SABR format is Opus, and
    // so whether Phase 2 needs a plain demux or an FFmpeg transcode.
    let sabrNeedsTranscode = false;

    // Applies a successful _acquireSabr() result to the locals above.
    const applySabr = (sabrResult) => {
      nodeStream = sabrResult.nodeStream;
      usedSabr = true;
      streamFormat = sabrResult.format;
      sabrNeedsTranscode = sabrResult.needsTranscode;
      // Set immediately (not after Phase 2 succeeds) -- any later failure
      // still needs this track's fetch loop stopped via _abortActiveSabr().
      this._activeAbort = sabrResult.abort;
    };

    if (track.isMusic) {
      // YTM: direct-URL confirmed reliable, tried first; SABR is a safety-net fallback.
      try {
        nodeStream = await this._acquireDirect(track, info, format);
      } catch (directErr) {
        const sd = info.streaming_data || {};
        if (!sd.server_abr_streaming_url) {
          await this._logStreamFailureDiagnostic(track, info, format, directErr);
          throw directErr;
        }
        console.warn(
          `[player:${this.guildId}] direct download failed for ${track.videoId} ` +
          `(${directErr.message}); falling back to SABR`
        );
        try {
          applySabr(await this._acquireSabr(track, info, session, format, poToken));
        } catch (sabrErr) {
          await this._logStreamFailureDiagnostic(track, info, format, directErr, sabrErr);
          throw sabrErr;
        }
      }
    } else {
      // Plain YouTube: increasingly SABR-only -- direct-URL throws
      // synchronously for these, so go straight to SABR. Direct-URL is
      // only a last-resort fallback if no SABR delivery exists either.
      const sd = info.streaming_data || {};
      if (sd.server_abr_streaming_url) {
        try {
          applySabr(await this._acquireSabr(track, info, session, format, poToken));
        } catch (sabrErr) {
          console.warn(
            `[player:${this.guildId}] SABR acquisition failed for ${track.videoId} ` +
            `(${sabrErr.message}); falling back to direct download`
          );
          try {
            nodeStream = await this._acquireDirect(track, info, format);
          } catch (directErr) {
            await this._logStreamFailureDiagnostic(track, info, format, directErr, sabrErr);
            throw directErr;
          }
        }
      } else {
        try {
          nodeStream = await this._acquireDirect(track, info, format);
        } catch (directErr) {
          await this._logStreamFailureDiagnostic(track, info, format, directErr);
          throw directErr;
        }
      }
    }

    // PHASE 2: prebuffer wiring — identical regardless of which stream
    // acquisition path succeeded above. Errors here (e.g. the acquired
    // stream itself errors mid-prebuffer) are NOT retried with the other
    // path; by this point we already have a "working" stream per
    // whichever method succeeded in Phase 1, so a failure here is a
    // genuine playback failure, not a reason to fall back again.
    let stage1 = null;

    // Permanent -- .pipe() doesn't forward 'error' events, and the
    // prebuffer promise below only listens with .once() until it settles.
    // Without this, a late nodeStream error (mid-track drop, stall,
    // attestation failure) would be unhandled and crash the whole process.
    nodeStream.on('error', (err) => {
      if (stage1 && !stage1.destroyed) stage1.destroy(err);
    });

    // [network] chunk-arrival gap tracking, MB_VERBOSE only. Watches the
    // raw CDN fetch (source side), separate from stage1/stage2's own
    // buffer monitors, to tell "fetch paused" from "fetch fine, drain slow".
    let lastChunkAt = null;
    if (log.isVerbose()) {
      nodeStream.on('data', (chunk) => {
        const now = Date.now();
        if (lastChunkAt !== null) {
          const gapMs = now - lastChunkAt;
          // 100ms: above normal jitter, below the glitch cadence being chased.
          if (gapMs >= 100) {
            log.debug(
              `player:${this.guildId}`,
              `[network] ${track.videoId} gap: ${gapMs}ms since last chunk ` +
              `(source: ${usedSabr ? 'SABR' : 'direct'}), this chunk ${chunk.length} bytes`
            );
          }
        }
        lastChunkAt = now;
      });
    }

    let result;
    let prebufferTargetBytes; // hoisted -- also read by the debug log below
    let bitrateBps; // hoisted -- also read by the debug log below
    try {
      bitrateBps = streamFormat.bitrate > 0 ? streamFormat.bitrate : config.assumedBitrateBps;
      prebufferTargetBytes = Math.max(
        1,
        Math.ceil((bitrateBps / 8) * config.prebufferSeconds)
      );
      const networkHighWaterMark = Math.max(
        prebufferTargetBytes,
        Math.ceil((bitrateBps / 8) * (config.networkBufferMs / 1000))
      );

      // Stage 1: network buffer. Withholds output until prebufferTargetBytes
      // accumulates, then keeps buffering up to networkHighWaterMark to
      // smooth CDN jitter for the rest of the track.
      stage1 = new PrebufferTransform({
        targetBytes: prebufferTargetBytes,
        highWaterMark: networkHighWaterMark,
      });

      const prebufferedPromise = new Promise((resolve, reject) => {
        const onPrebuffered = () => {
          cleanup();
          resolve({ timedOut: false });
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const timer = setTimeout(() => {
          cleanup();
          // Must actually release buffered data here, or "starting
          // anyway" below is a lie -- stage1 would keep withholding until
          // targetBytes is reached regardless of this timeout.
          stage1.forceRelease();
          resolve({ timedOut: true });
        }, config.prebufferTimeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          stage1.off('prebuffered', onPrebuffered);
          stage1.off('error', onError);
        };
        stage1.once('prebuffered', onPrebuffered);
        stage1.once('error', onError);
      });

      nodeStream.pipe(stage1);

      result = await prebufferedPromise;
    } catch (err) {
      console.warn(
        `[player:${this.guildId}] prebuffer stage failed for ${track.videoId} ` +
        `(source: ${usedSabr ? 'SABR' : 'direct'}): ${describeStreamError(err, usedSabr)}`
      );
      throw err;
    }

    if (result.timedOut) {
      console.warn(
        `[player:${this.guildId}] prebuffer timed out for ${track.videoId}; starting anyway`
      );
    }

    // Stage 2 + demux: stall-buffered stream of raw Opus frames, wired
    // with explicit error propagation across every stage (see
    // demuxPipeline.js -- .pipe() alone does NOT forward 'error' events,
    // and an unhandled one here would crash the whole bot process, not
    // just fail this track).
    const buildPipeline = sabrNeedsTranscode ? buildTranscodedOpusPipeline : buildOpusPipeline;
    const opusStream = buildPipeline(stage1, {
      highWaterMark: config.stallBufferFrames,
      onError: (err, { firstBytes }) => {
        const hex = firstBytes ? firstBytes.toString('hex') : '(no data received before failure)';
        console.error(
          `[player:${this.guildId}] ${sabrNeedsTranscode ? 'transcode' : 'demux'} pipeline error ` +
          `for ${track.videoId} (source: ${usedSabr ? 'SABR' : 'direct'}): ${describeStreamError(err, usedSabr)}\n` +
          `  first bytes received: ${hex}`
        );
      },
    });

    // Buffer state: 5s periodic snapshot of each stage's buffer, reported
    // as seconds/ms of audio held. stage1 is byte-mode (converted via
    // bitrate); stage2 is object-mode frames (converted via OPUS_FRAME_MS).
    //
    // A 5s snapshot can't see a shorter glitch -- the starve monitor below
    // covers that gap, polling stage2 on the same 20ms cadence
    // @discordjs/voice itself reads from it (5 consecutive empty reads
    // there stops the track). Logged immediately per run, not batched
    // into the 5s summary, so the run's actual duration isn't lost.
    if (log.isVerbose()) {
      const bytesPerSec = bitrateBps / 8;
      // Infinity, not 0 -- both streams start empty, so seeding from the
      // current value would report a false starvation minimum for window 1.
      let minStage1Since = Infinity;
      let minStage2Since = Infinity;
      const bufferLogInterval = setInterval(() => {
        const netSec = (stage1.readableLength / bytesPerSec).toFixed(1);
        const targetSec = config.prebufferSeconds.toFixed(1);
        const stallMs = opusStream.readableLength * OPUS_FRAME_MS;
        const minNetSec = (minStage1Since / bytesPerSec).toFixed(1);
        const minStallMs = minStage2Since * OPUS_FRAME_MS;
        log.debug(
          `player:${this.guildId}`,
          `[stage1] ${track.videoId} net ${netSec}/${targetSec}s (min since last log: ${minNetSec}s)`
        );
        log.debug(
          `player:${this.guildId}`,
          `[stage2] ${track.videoId} stall ${stallMs}/${config.stallBufferMs}ms (min since last log: ${minStallMs}ms)`
        );
        minStage1Since = stage1.readableLength;
        minStage2Since = opusStream.readableLength;
      }, 5000);

      let consecutiveEmptyPolls = 0;
      let runStartedAt = null;
      const starveMonitor = setInterval(() => {
        minStage1Since = Math.min(minStage1Since, stage1.readableLength);
        minStage2Since = Math.min(minStage2Since, opusStream.readableLength);
        if (opusStream.readableLength > 0) {
          if (consecutiveEmptyPolls > 0) {
            log.debug(
              `player:${this.guildId}`,
              `[stage2] ${track.videoId} STARVE end: empty for ${consecutiveEmptyPolls} consecutive ` +
              `${OPUS_FRAME_MS}ms poll(s) (~${consecutiveEmptyPolls * OPUS_FRAME_MS}ms), ` +
              `started ${Date.now() - runStartedAt}ms ago -- @discordjs/voice substituted silence frames for this span`
            );
          }
          consecutiveEmptyPolls = 0;
          runStartedAt = null;
          return;
        }
        if (consecutiveEmptyPolls === 0) {
          runStartedAt = Date.now();
          log.debug(`player:${this.guildId}`, `[stage2] ${track.videoId} STARVE start: empty`);
        }
        consecutiveEmptyPolls++;
      }, OPUS_FRAME_MS);

      const stopBufferLog = () => {
        clearInterval(bufferLogInterval);
        clearInterval(starveMonitor);
      };
      opusStream.once('end', stopBufferLog);
      opusStream.once('error', stopBufferLog);
      opusStream.once('close', stopBufferLog);
    }

    return createAudioResource(opusStream, {
      inputType: StreamType.Opus,
      metadata: track,
    });
  }
}

class PlayerManager {
  constructor(queueManager, client) {
    this.queueManager = queueManager;
    this.client = client;
    /** @type {Map<string, GuildPlayer>} */
    this.players = new Map();
  }

  get(guildId) {
    if (!this.players.has(guildId)) {
      const player = new GuildPlayer(guildId, this.queueManager.get(guildId), this.client, () => this.delete(guildId));
      this.players.set(guildId, player);
    }
    return this.players.get(guildId);
  }

  has(guildId) {
    return this.players.has(guildId);
  }

  delete(guildId) {
    const player = this.players.get(guildId);
    player?.disconnect();
    this.players.delete(guildId);
    this.queueManager.delete(guildId);
  }
}

module.exports = { PlayerManager, GuildPlayer };
