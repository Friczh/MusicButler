import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';

export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

export function loginDiscordClient() {
  return discordClient.login(config.discordToken);
}
