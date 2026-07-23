import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commandDefinitions } from './commands/definitions.js';
import { handleInteraction } from './commands/handler.js';
import { Playback } from './playback.js';
import { queueManager } from './queue/queueManager.js';
import { startPortShim } from './portShim.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const playback = new Playback();

startPortShim(() => ({
  status: 'ok',
  discordConnected: client.isReady(),
  nowPlaying: queueManager.nowPlaying?.title ?? null,
  queueLength: queueManager.queue.length,
}));

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationCommands(config.clientId), { body: commandDefinitions });
  console.log('Global commands registered.');
});

client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction, playback);
  } catch (err) {
    console.error('[interaction] error:', err.message);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: `Error: ${err.message}`, ephemeral: true });
    }
  }
});

process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

client.login(config.discordToken);
