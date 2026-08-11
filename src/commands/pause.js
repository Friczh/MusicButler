'use strict';

const { MessageFlags } = require('discord.js');

module.exports = {
  name: 'pause',
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    if (!player.connection || !player.queue.playing) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }
    const ok = player.pause();
    // Public but silent -- see skip.js's comment for why this has to be
    // on the initial reply() rather than added later.
    await interaction.reply({
      content: ok ? '⏸️ Paused.' : "Couldn't pause.",
      flags: MessageFlags.SuppressNotifications,
    });
  },
};
