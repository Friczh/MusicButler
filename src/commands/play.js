'use strict';

const { MessageFlags } = require('discord.js');
const { getSession } = require('../lib/innertube');
const { classifyInput, resolveQuery, resolvePlaylistTracks } = require('../lib/extract');
const { config } = require('../lib/config');

/**
 * Races `promise` against a timeout so a stalled YouTube API call fails
 * fast with an actionable message instead of leaving the caller (here,
 * /play's "🔎 Resolving..." reply) stuck indefinitely. The underlying
 * call is NOT cancelled -- it keeps running in the background (harmless;
 * getSession()'s result still gets cached for next time if it eventually
 * succeeds) -- this only stops WAITING on it.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Core of /play, extracted so the panel's Play-button modal (see index.js)
 * can reuse it without an interaction object. Never touches
 * interaction.reply/editReply itself -- callers own their own reply
 * lifecycle (deferReply vs. modal-submit reply differ).
 *
 * @returns {Promise<{ ok: true, replyText: string } | { ok: false, errorText: string }>}
 */
async function resolveAndQueue(query, { voiceChannel, guildId, channelId, requestedBy, playerManager }) {
  const classification = classifyInput(query);
  if (classification.kind === 'unsupported') {
    return { ok: false, errorText: "That's a radio/mix link without a specific video — link a track from it directly instead." };
  }

  // Determine session client_type up front so we bootstrap the right
  // context from the start (search has no music-specific path, so it
  // always stays WEB).
  const isMusicRequest = classification.kind !== 'search' && classification.isMusic;

  let tracksToQueue;
  let replyText;
  try {
    const session = await withTimeout(
      getSession({ clientType: isMusicRequest ? 'YTMUSIC' : 'WEB' }),
      config.resolveTimeoutMs,
      'Timed out contacting YouTube -- try again in a moment.'
    );

    if (classification.kind === 'playlist') {
      const resolved = await withTimeout(
        resolvePlaylistTracks(session, classification.playlistId, classification.isMusic, { maxTracks: config.playlistMaxTracks }),
        config.resolveTimeoutMs,
        'Timed out resolving that playlist -- try again in a moment.'
      );
      if (resolved.length === 0) {
        return { ok: false, errorText: 'That playlist has no playable tracks.' };
      }
      tracksToQueue = resolved;
      replyText = `📜 Queued playlist: **${resolved.length}** track${resolved.length === 1 ? '' : 's'}`;
    } else {
      // 'video' or 'search' — resolveQuery re-derives this itself.
      const resolved = await withTimeout(
        resolveQuery(session, query),
        config.resolveTimeoutMs,
        'Timed out resolving that -- try again in a moment.'
      );
      tracksToQueue = [resolved];
      replyText = `🎵 Queued: **${resolved.title}**`;
    }
  } catch (err) {
    return { ok: false, errorText: `Couldn't resolve that: ${err.message}` };
  }

  const player = playerManager.get(guildId);
  if (!player.connection) {
    try {
      await player.connect(voiceChannel);
    } catch (err) {
      return { ok: false, errorText: `Couldn't join voice channel: ${err.message}` };
    }
  }
  player.queue.voiceChannelId = voiceChannel.id;
  player.queue.textChannelId = channelId;

  await player.enqueueMany(
    tracksToQueue.map((t) => ({
      videoId: t.videoId,
      isMusic: t.isMusic,
      title: t.title,
      duration: t.duration,
      requestedBy,
    }))
  );

  return { ok: true, replyText };
}

module.exports = {
  name: 'play',
  resolveAndQueue,
  withTimeout,
  async execute(interaction, { playerManager }) {
    const query = interaction.options.getString('query', true);
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
      return;
    }

    // A real reply() with a placeholder, not deferReply() -- this is the
    // only way to get SuppressNotifications on the eventual result:
    // that flag has to be set at message creation, and editReply() can't
    // add it afterward (confirmed against installed source). reply()
    // itself is the acknowledgment, same 3s-window requirement deferReply
    // would have met.
    await interaction.reply({ content: '🔎 Resolving...', flags: MessageFlags.SuppressNotifications });

    const result = await resolveAndQueue(query, {
      voiceChannel,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      requestedBy: interaction.user.id,
      playerManager,
    });

    await interaction.editReply(result.ok ? result.replyText : result.errorText);
  },
};
