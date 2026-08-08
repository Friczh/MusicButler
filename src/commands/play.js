'use strict';

const { getSession } = require('../lib/innertube');
const { classifyInput, resolveQuery, resolvePlaylistTracks } = require('../lib/extract');
const { config } = require('../lib/config');

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
  const session = await getSession({ clientType: isMusicRequest ? 'YTMUSIC' : 'WEB' });

  let tracksToQueue;
  let replyText;
  try {
    if (classification.kind === 'playlist') {
      const resolved = await resolvePlaylistTracks(
        session,
        classification.playlistId,
        classification.isMusic,
        { maxTracks: config.playlistMaxTracks }
      );
      if (resolved.length === 0) {
        return { ok: false, errorText: 'That playlist has no playable tracks.' };
      }
      tracksToQueue = resolved;
      replyText = `Queued playlist: **${resolved.length}** track${resolved.length === 1 ? '' : 's'}`;
    } else {
      // 'video' or 'search' — resolveQuery re-derives this itself.
      const resolved = await resolveQuery(session, query);
      tracksToQueue = [resolved];
      replyText = `Queued: **${resolved.title}**`;
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
  async execute(interaction, { playerManager }) {
    const query = interaction.options.getString('query', true);
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

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
