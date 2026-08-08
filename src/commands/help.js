'use strict';

const { EmbedBuilder } = require('discord.js');

// Maintained by hand rather than derived from commandDefs.js -- deliberate,
// so grantopnopassword never shows up here no matter what gets added to
// the command list later.
const ENTRIES = [
  ['/play <query>', 'Play a YouTube/YouTube Music URL or search query'],
  ['/skip', 'Skip the current track'],
  ['/pause', 'Pause playback'],
  ['/resume', 'Resume playback'],
  ['/leave', 'Leave the voice channel and clear the queue'],
  ['/queue list', 'Show the current queue'],
  ['/queue remove <position>', 'Remove a track by position'],
  ['/queue swap <a> <b>', 'Swap two tracks by position'],
  ['/queue move <from> <to>', 'Move a track to a new position'],
  ['/queue clear', 'Clear the queue'],
  ['/clearmessage', "Delete this bot's recent messages in this channel"],
  ['/panel', 'Bring up the control panel in this channel'],
  ['/help', 'Show this list'],
];

module.exports = {
  name: 'help',
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('MusicButler commands')
      .setDescription(ENTRIES.map(([cmd, desc]) => `**${cmd}** — ${desc}`).join('\n'));
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
