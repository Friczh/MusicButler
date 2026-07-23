import { queueManager } from '../queue/queueManager.js';

export async function handleInteraction(interaction, playback) {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'play') {
    const query = interaction.options.getString('query', true);
    queueManager.add({ videoId: query, title: query, requestedBy: interaction.user.id });
    await interaction.reply(`Queued: ${query}`);
    playback.ensurePlaying(interaction);
    return;
  }

  if (commandName === 'skip') {
    playback.skip();
    await interaction.reply('Skipped.');
    return;
  }

  if (commandName === 'pause') {
    playback.pause();
    await interaction.reply('Paused.');
    return;
  }

  if (commandName === 'resume') {
    playback.resume();
    await interaction.reply('Resumed.');
    return;
  }

  if (commandName === 'leave') {
    playback.leave();
    await interaction.reply('Left voice channel.');
    return;
  }

  if (commandName === 'queue') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const { nowPlaying, upcoming } = queueManager.list();
      const lines = [
        `Now playing: ${nowPlaying ? nowPlaying.title : '(nothing)'}`,
        ...upcoming.map((t, i) => `${i + 1}. ${t.title}`),
      ];
      await interaction.reply(lines.join('\n') || 'Queue is empty.');
      return;
    }

    if (sub === 'remove') {
      const position = interaction.options.getInteger('position', true);
      const result = queueManager.remove(position);
      await interaction.reply(result.error ? result.message : `Removed: ${result.removed.title}`);
      return;
    }

    if (sub === 'swap') {
      const a = interaction.options.getInteger('position_a', true);
      const b = interaction.options.getInteger('position_b', true);
      const result = queueManager.swap(a, b);
      await interaction.reply(result.error ? result.message : 'Swapped.');
      return;
    }

    if (sub === 'move') {
      const from = interaction.options.getInteger('from', true);
      const to = interaction.options.getInteger('to', true);
      const result = queueManager.move(from, to);
      await interaction.reply(result.error ? result.message : `Moved: ${result.track.title}`);
      return;
    }

    if (sub === 'clear') {
      queueManager.clear();
      await interaction.reply('Queue cleared.');
      return;
    }
  }
}
