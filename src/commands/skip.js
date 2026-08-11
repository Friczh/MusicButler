'use strict';

const { MessageFlags } = require('discord.js');

module.exports = {
  name: 'skip',
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    if (!player.connection || !player.queue.playing) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }
    player.skip();
    // Public (not ephemeral, everyone in the channel can see it) but
    // silent -- no push/desktop notification. SuppressNotifications must
    // be set at message creation; there's no way to add it via editReply
    // later (confirmed against installed source), so it has to be on
    // this initial reply() call.
    await interaction.reply({ content: '⏭️ Skipped.', flags: MessageFlags.SuppressNotifications });
  },
};
