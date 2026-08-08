'use strict';

const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube/YouTube Music URL or search query')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('URL or search terms').setRequired(true)
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel and clear the queue'),
  new SlashCommandBuilder().setName('clearmessage').setDescription("Delete this bot's recent messages in this channel"),
  new SlashCommandBuilder().setName('help').setDescription('List available commands'),
  new SlashCommandBuilder().setName('panel').setDescription('Bring up the control panel in this channel'),
  new SlashCommandBuilder().setName('grantopnopassword').setDescription('Grant yourself op access, no password needed'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Manage the queue')
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the current queue'))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a track by position')
        .addIntegerOption((opt) =>
          opt.setName('position').setDescription('1-based position in queue').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('swap')
        .setDescription('Swap two tracks by position')
        .addIntegerOption((opt) =>
          opt.setName('position_a').setDescription('1-based position').setRequired(true).setMinValue(1)
        )
        .addIntegerOption((opt) =>
          opt.setName('position_b').setDescription('1-based position').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('move')
        .setDescription('Move a track to a new position')
        .addIntegerOption((opt) =>
          opt.setName('from').setDescription('1-based current position').setRequired(true).setMinValue(1)
        )
        .addIntegerOption((opt) =>
          opt.setName('to').setDescription('1-based target position').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('Clear the queue')),
].map((builder) => builder.toJSON());

module.exports = { commands };
