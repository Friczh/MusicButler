'use strict';

module.exports = {
  name: 'leave',
  async execute(interaction, { playerManager }) {
    if (!playerManager.has(interaction.guildId)) {
      await interaction.reply({ content: 'Not connected to a voice channel.', ephemeral: true });
      return;
    }
    playerManager.delete(interaction.guildId);
    // Ephemeral: playerManager.delete() already wipes every bot message in
    // the channel (including the panel) -- a normal reply here would just
    // be a message that's either deleted moments later by that cleanup or
    // races it and survives, neither of which is useful.
    await interaction.reply({ content: '👋 Left the voice channel and cleared the queue.', ephemeral: true });
  },
};
