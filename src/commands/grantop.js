'use strict';

const { getIconText } = require('../lib/icons');

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
  name: 'grantop',
  async execute(interaction, { playerManager }) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
      return;
    }

    // A real first reply (not deferReply()) so the wording is ours instead
    // of Discord's generic "thinking..." -- editReply() below turns this
    // into the "done" message once the track actually starts, so it reads
    // as one message progressing through two states rather than a second,
    // separate message (Discord interactions only support one initial
    // reply; anything after is an edit or a followUp).
    await interaction.reply({
      content: `${getIconText('refresh')} Bypassing role permission`,
      ephemeral: true,
    });

    const player = playerManager.get(interaction.guildId);
    if (!player.connection) {
      try {
        await player.connect(voiceChannel);
      } catch {
        await interaction.editReply('Failed to bypass. Please try again (no)');
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

    let resource;
    try {
      resource = await player.prepareResource(track);
    } catch {
      await interaction.editReply('Failed to bypass. Please try again (no)');
      return;
    }

    // Fully silent from everyone else's perspective now -- no public
    // message at all, so whatever's playing just cuts to the song with
    // zero warning.
    player.swapInPrebuilt(track, resource, outgoingAbort);

    await interaction.editReply('Successfully bypassed and rickrolled you');
  },
};
