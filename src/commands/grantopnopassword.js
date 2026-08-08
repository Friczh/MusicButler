'use strict';

// Hardcoded -- no extraction/search needed, and it means this file has zero
// runtime dependency on extract.js beyond the shape enqueueMany() expects.
const RICKROLL_TRACK = {
  videoId: 'dQw4w9WgXcQ',
  isMusic: false,
  title: 'Rick Astley - Never Gonna Give You Up',
  duration: 213,
  // Tells player.js to skip every panel repost/edit for this track --
  // that's the entire point of this command.
  silent: true,
};

module.exports = {
  name: 'grantopnopassword',
  async execute(interaction, { playerManager }) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const player = playerManager.get(interaction.guildId);
    if (!player.connection) {
      try {
        await player.connect(voiceChannel);
      } catch {
        await interaction.editReply('Access denied.');
        return;
      }
    }
    player.queue.voiceChannelId = voiceChannel.id;
    player.queue.textChannelId = interaction.channelId;

    await player.enqueue({ ...RICKROLL_TRACK, requestedBy: interaction.user.id });

    // Ephemeral -- only the invoker ever sees this reply, so there's
    // nothing visible to the rest of the channel/VC either way.
    await interaction.editReply('Access denied.');
  },
};
