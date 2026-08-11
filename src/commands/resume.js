'use strict';

const { MessageFlags } = require('discord.js');

module.exports = {
  name: 'resume',
  async execute(interaction, { playerManager }) {
    const player = playerManager.get(interaction.guildId);
    if (!player.connection) {
      await interaction.reply({ content: 'Not connected to a voice channel.', ephemeral: true });
      return;
    }
    const ok = player.resume();
    // Public but silent -- see skip.js's comment for why this has to be
    // on the initial reply() rather than added later.
    await interaction.reply({
      content: ok ? '▶️ Resumed.' : "Couldn't resume.",
      flags: MessageFlags.SuppressNotifications,
    });
  },
};
