'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { log } = require('./log');

const COLOR = 0x5865f2;

/** Formats whole seconds as "m:ss" or "h:mm:ss". 0/undefined -> "0:00". */
function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * @param {{ track: object|null, queueLength: number, isPaused: boolean }} state
 */
function buildPanelEmbed({ track, queueLength, isPaused }) {
  const embed = new EmbedBuilder().setColor(COLOR);

  if (!track) {
    embed.setTitle('Nothing playing').setDescription('Queue is empty. Hit **Play** to add something.');
    return embed;
  }

  embed
    .setTitle(isPaused ? '⏸ Paused' : '▶ Now Playing')
    .setDescription(`**${track.title}**`)
    .addFields(
      // Static duration only -- no elapsed-time/progress bar, which would
      // require a recurring edit interval to keep current. Set once when
      // the panel is built/reposted.
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Up next', value: String(queueLength), inline: true }
    );

  if (track.requestedBy) {
    // Embed field values parse mentions; author/footer text does not --
    // confirmed against Discord's embed rendering behavior.
    embed.addFields({ name: 'Requested by', value: `<@${track.requestedBy}>`, inline: true });
  }

  return embed;
}

function buildPanelComponents(isPaused) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('panel_pauseresume')
        .setLabel(isPaused ? 'Resume' : 'Pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_queue').setLabel('Queue').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_play').setLabel('Play').setStyle(ButtonStyle.Primary)
    ),
  ];
}

/** Fetches the text channel for a queue, or null if it can't be resolved. */
async function fetchPanelChannel(client, queue) {
  if (!queue.textChannelId) return null;
  try {
    const channel = await client.channels.fetch(queue.textChannelId);
    return channel?.isTextBased() ? channel : null;
  } catch (err) {
    log.debug('panel', `couldn't fetch channel ${queue.textChannelId}: ${err.message}`);
    return null;
  }
}

/**
 * Deletes the previous panel message (if any) and sends a fresh one at the
 * bottom of the channel. Used on track change, so the panel doesn't stay
 * buried under a flood of unrelated chat.
 */
async function repostPanel(client, queue, { isPaused = false } = {}) {
  const channel = await fetchPanelChannel(client, queue);
  if (!channel) return;

  if (queue.panelMessageId) {
    try {
      const old = await channel.messages.fetch(queue.panelMessageId);
      await old.delete();
    } catch {
      // Already gone (manually deleted, /clearmessage, etc.) -- fine.
    }
    queue.panelMessageId = null;
  }

  try {
    const message = await channel.send({
      embeds: [buildPanelEmbed({ track: queue.playing, queueLength: queue.list().length, isPaused })],
      components: buildPanelComponents(isPaused),
    });
    queue.panelMessageId = message.id;
  } catch (err) {
    log.error('panel', `failed to send panel: ${err.message}`);
  }
}

/**
 * Edits the existing panel message in place (no new message) -- used for
 * pause/resume, queue-add, and anything else that shouldn't cause repost
 * churn. Falls back to repostPanel() if the old message can't be found
 * (e.g. deleted out from under it), so drift never leaves the panel gone.
 */
async function editPanelInPlace(client, queue, { isPaused = false } = {}) {
  const channel = await fetchPanelChannel(client, queue);
  if (!channel || !queue.panelMessageId) {
    return repostPanel(client, queue, { isPaused });
  }

  try {
    const message = await channel.messages.fetch(queue.panelMessageId);
    await message.edit({
      embeds: [buildPanelEmbed({ track: queue.playing, queueLength: queue.list().length, isPaused })],
      components: buildPanelComponents(isPaused),
    });
  } catch (err) {
    log.debug('panel', `edit-in-place failed (${err.message}), reposting instead`);
    await repostPanel(client, queue, { isPaused });
  }
}

module.exports = { formatDuration, buildPanelEmbed, buildPanelComponents, repostPanel, editPanelInPlace };
