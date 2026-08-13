'use strict';

const { MessageFlags } = require('discord.js');
const { getIconText } = require('../lib/icons');

/**
 * Exported so the panel's Shuffle button (panelInteractions.js) uses
 * identical text.
 */
function shuffleReplyText({ active, count, refused }) {
  const icon = getIconText(active ? 'shuffle_on' : 'shuffle_off');
  if (refused) {
    return count === 0 ? `${icon} Nothing to shuffle.` : `${icon} Queue too short to shuffle.`;
  }
  if (active) {
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
