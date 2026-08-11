'use strict';

const { MessageFlags } = require('discord.js');
const { getIconText } = require('../lib/icons');

/**
 * Fisher-Yates on 0 or 1 upcoming tracks is a correct no-op (nothing to
 * reorder) -- but "Shuffled 0 tracks" reads like an error, so these get
 * their own wording instead of the generic count message. Exported so the
 * panel's Shuffle button (panelInteractions.js) uses identical text.
 */
function shuffleReplyText(n) {
  if (n === 0) return `${getIconText('shuffle')} Nothing to shuffle.`;
  if (n === 1) return `${getIconText('shuffle')} Queue too short to shuffle.`;
  return `${getIconText('shuffle')} Shuffled ${n} tracks.`;
}

module.exports = {
  name: 'shuffle',
  shuffleReplyText,
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    const n = player.queue.shuffle();
    // Public but silent -- see skip.js's comment for why the flag has to
    // be on this initial reply() call, not added via editReply() later.
    await interaction.reply({ content: shuffleReplyText(n), flags: MessageFlags.SuppressNotifications });
  },
};
