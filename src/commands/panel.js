'use strict';

const { repostPanel } = require('../lib/panel');

module.exports = {
  name: 'panel',
  async execute(interaction, { playerManager }) {
    await interaction.deferReply({ ephemeral: true });

    const player = playerManager.get(interaction.guildId);
    // Doesn't require an active voice connection -- posting the panel
    // while idle is exactly how you'd use its Play button to start
    // something in the first place.
    player.queue.textChannelId = interaction.channelId;

    await repostPanel(interaction.client, player.queue, { isPaused: player.isPaused() });
    await interaction.editReply('📌 Panel posted.');
  },
};
