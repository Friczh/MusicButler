'use strict';

const { MessageFlags } = require('discord.js');
const { getIconText } = require('../lib/icons');

/**
 * Exported so the panel's Shuffle button (panelInteractions.js) uses
 * identical text.
 */
function shuffleReplyText({ active, count }) {
  const icon = getIconText(active ? 'shuffle_on' : 'shuffle_off');
  if (active) {
    if (count === 0) return `${icon} Nothing to shuffle.`;
    if (count === 1) return `${icon} Queue too short to shuffle.`;
    return `${icon} Shuffle on -- ${count} tracks shuffled.`;
  }
  return `${icon} Shuffle off -- original order restored.`;
}

module.exports = {
  name: 'shuffle',
  shuffleReplyText,
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    const result = player.queue.toggleShuffle();
    // Public but silent -- see skip.js's comment for why the flag has to
    // be on this initial reply() call, not added via editReply() later.
    await interaction.reply({ content: shuffleReplyText(result), flags: MessageFlags.SuppressNotifications });
  },
};
