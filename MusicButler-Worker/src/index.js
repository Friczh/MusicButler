import { loginDiscordClient, discordClient } from './discord/client.js';
import { startControlServer } from './ws/controlServer.js';

startControlServer();

discordClient.once('ready', () => {
  console.log(`[discord] Worker voice client logged in as ${discordClient.user.tag}`);
});

loginDiscordClient();

process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
