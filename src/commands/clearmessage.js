'use strict';

const { clearBotMessages } = require('../lib/messageCleanup');

module.exports = {
  name: 'clearmessage',
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await clearBotMessages(interaction.client, interaction.channelId);
    await interaction.editReply('Cleared this bot\'s messages in this channel.');
  },
};
