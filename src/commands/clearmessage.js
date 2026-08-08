'use strict';

const { clearBotMessages } = require('../lib/messageCleanup');

module.exports = {
  name: 'clearmessage',
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const { deleted, failed } = await clearBotMessages(interaction.client, interaction.channelId);
    const text =
      failed > 0
        ? `⚠️ Deleted ${deleted}, failed to delete ${failed} (likely missing Manage Messages permission in this channel).`
        : deleted > 0
          ? `🧹 Cleared ${deleted} message(s).`
          : 'Nothing to clear.';
    await interaction.editReply(text);
  },
};
