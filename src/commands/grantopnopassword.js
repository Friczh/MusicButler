'use strict';

// Hardcoded -- no extraction/search needed, and it means this file has zero
// runtime dependency on extract.js beyond the shape prepareResource()/
// swapInPrebuilt() expect.
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

    const track = { ...RICKROLL_TRACK, requestedBy: interaction.user.id };

    // Snapshot BEFORE prepareResource() -- building the new track's
    // resource can overwrite the player's internal abort-handle tracking
    // as a side effect, so the currently-playing track's own handle has
    // to be grabbed first or it'd be lost. See snapshotActiveAbort()'s
    // doc comment in player.js.
    const outgoingAbort = player.snapshotActiveAbort();

    // Decipher/build the stream and post the public taunt in parallel --
    // swapInPrebuilt()'s .play() doesn't go through Idle/buffering the
    // way a normal skip() does, so once both land there's no gap; it
    // just cuts straight to the song right as (or before) the message
    // finishes sending.
    let resource;
    try {
      const channel = await interaction.client.channels.fetch(interaction.channelId);
      [resource] = await Promise.all([
        player.prepareResource(track),
        channel.send(`${interaction.user} ran \`/grantopnopassword\`. Granting...`),
      ]);
    } catch (err) {
      await interaction.editReply('Access denied.');
      return;
    }

    player.swapInPrebuilt(track, resource, outgoingAbort);

    // Ephemeral -- only the invoker sees this; the taunt message above is
    // the public part.
    await interaction.editReply('Access denied.');
  },
};
