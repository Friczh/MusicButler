'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { log } = require('./log');
const { getIcon, getIconText } = require('./icons');
const { config } = require('./config');

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
 * @param {{ track: object|null, queueLength: number, isPaused: boolean, repeatMode?: string, shuffleActive?: boolean }} state
 */
function buildPanelEmbed({ track, queueLength, isPaused, repeatMode = 'off', shuffleActive = false }) {
  const embed = new EmbedBuilder().setColor(COLOR);

  if (!track) {
    const idleLine = config.idleTimeoutMin > 0
      ? `\n\n⏱️ Auto-leaving after ${config.idleTimeoutMin} min idle.`
      : '';
    return embed
      .setTitle(`${getIconText('stop')} Nothing playing`)
      .setDescription(`Queue is empty — hit **${getIconText('play')} Play** to add something.${idleLine}`);
  }

  // Everything except the title packed onto one line -- duration, queue
  // count, requester -- rather than separate embed fields, which each
  // carry their own name/value line and padding.
  const parts = [`⏱️ ${formatDuration(track.duration)}`, `${getIconText('queue')} ${queueLength} queued`];
  // Only shown when active -- keeps the common (off) case just as
  // compact as before rather than always reserving space for it.
  if (repeatMode !== 'off') parts.push(`${getIconText(`repeat_${repeatMode}`)} ${repeatMode === 'one' ? 'Repeat one' : 'Repeat all'}`);
  if (shuffleActive) parts.push(`${getIconText('shuffle_on')} Shuffle on`);
  if (track.requestedBy) parts.push(`🙋 <@${track.requestedBy}>`);

  const statusIcon = getIconText(isPaused ? 'pause' : 'play');
  return embed.setTitle(`${statusIcon} ${track.title}`).setDescription(parts.join('  •  '));
}

function buildPanelComponents({ isPaused = false, repeatMode = 'off', shuffleActive = false } = {}) {
  return [
    // Playback controls
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('panel_pauseresume')
        .setEmoji(getIcon(isPaused ? 'play' : 'pause'))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_skip').setEmoji(getIcon('skip')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_stop').setEmoji(getIcon('stop')).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_play').setEmoji(getIcon('play')).setStyle(ButtonStyle.Primary)
    ),
    // Queue / mode controls
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_queue').setEmoji(getIcon('queue')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('panel_repeat')
        .setEmoji(getIcon(`repeat_${repeatMode}`))
        .setStyle(repeatMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('panel_shuffle')
        .setEmoji(getIcon(shuffleActive ? 'shuffle_on' : 'shuffle_off'))
        .setStyle(ButtonStyle.Secondary)
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
      embeds: [buildPanelEmbed({ track: queue.playing, queueLength: queue.list().length, isPaused, repeatMode: queue.repeatMode, shuffleActive: queue.shuffleActive })],
      components: buildPanelComponents({ isPaused, repeatMode: queue.repeatMode, shuffleActive: queue.shuffleActive }),
      // Public, not ephemeral -- everyone in the channel needs to see and
      // use it -- but silent, since this fires on every track change and
      // was the original motivating complaint (VC flooded with
      // notifications every time a track started).
      flags: MessageFlags.SuppressNotifications,
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
      embeds: [buildPanelEmbed({ track: queue.playing, queueLength: queue.list().length, isPaused, repeatMode: queue.repeatMode, shuffleActive: queue.shuffleActive })],
      components: buildPanelComponents({ isPaused, repeatMode: queue.repeatMode, shuffleActive: queue.shuffleActive }),
    });
  } catch (err) {
    log.debug('panel', `edit-in-place failed (${err.message}), reposting instead`);
    await repostPanel(client, queue, { isPaused });
  }
}

module.exports = { formatDuration, buildPanelEmbed, buildPanelComponents, repostPanel, editPanelInPlace };
