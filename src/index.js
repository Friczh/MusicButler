'use strict';

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { commands } = require('./lib/commandDefs');
const { QueueManager } = require('./lib/queueManager');
const { PlayerManager } = require('./lib/player');
const { waitForReady: waitForPotProvider } = require('./lib/potProvider');
const { startHealthServer } = require('./lib/health');
const { log } = require('./lib/log');

const REQUIRED_ENV = ['DISCORD_TOKEN', 'YOUTUBE_COOKIES_BASE64'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Own toggle, separate from MB_VERBOSE -- this host binds a real port and
// only matters on Render (which requires it for its liveness check); the
// friend's-laptop deployment has no use for an HTTP server at all. Default
// off so a bare `docker compose up` outside Render doesn't open a port
// nobody's checking.
if (process.env.MB_HEALTH_ENABLED === 'true') {
  startHealthServer(client);
} else {
  log.debug('health', 'MB_HEALTH_ENABLED is not "true" -- health server not started');
}

// Discord gateway connection lifecycle -- shard is singular here (no
// sharding in use), but these are the only events discord.js exposes for
// "is the underlying websocket to Discord currently healthy."
client.on('shardDisconnect', (event, id) => {
  log.debug('gateway', `shard ${id} disconnected, code ${event.code}`);
});
client.on('shardReconnecting', (id) => {
  log.debug('gateway', `shard ${id} reconnecting`);
});
client.on('shardResume', (id, replayed) => {
  log.debug('gateway', `shard ${id} resumed, ${replayed} events replayed`);
});
client.on('shardError', (err, id) => {
  log.error('gateway', `shard ${id} error:`, err.message);
});

const queueManager = new QueueManager();
const playerManager = new PlayerManager(queueManager);
const ctx = { queueManager, playerManager };

const commandHandlers = new Collection();
for (const file of ['play', 'skip', 'pause', 'resume', 'leave', 'queue']) {
  const handler = require(`./commands/${file}`);
  commandHandlers.set(handler.name, handler);
}

client.once('ready', async () => {
  log.info('discord', `Connected to Discord with identify ${client.user.tag}`);

  try {
    await waitForPotProvider();
    log.info('discord', 'POT provider is ready.');
  } catch (err) {
    log.error('discord', 'POT provider health check failed:', err.message);
    // Keep running — playback commands will surface the real error per-track
    // rather than crash-looping the whole bot over a transient sidecar hiccup.
  }

  try {
    // client.application.commands.set() (rather than a manually-supplied
    // application ID) uses this client's own authenticated application ID,
    // which avoids the hard-to-read 400 Discord returns for a missing/wrong
    // application ID.
    await client.application.commands.set(commands);
    log.info('discord', `Registered ${commands.length} global slash commands.`);
  } catch (err) {
    log.error('discord', 'Failed to register slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const handler = commandHandlers.get(interaction.commandName);
  if (!handler) return;

  try {
    await handler.execute(interaction, ctx);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const payload = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  // Auto-leave when the bot ends up alone in a voice channel.
  const guildId = oldState.guild.id;
  if (!playerManager.has(guildId)) return;
  const player = playerManager.get(guildId);
  const channelId = player.queue.voiceChannelId;
  if (!channelId) return;
  const channel = oldState.guild.channels.cache.get(channelId);
  if (!channel) return;
  const humanMembers = channel.members.filter((m) => !m.user.bot);
  if (humanMembers.size === 0) {
    playerManager.delete(guildId);
  }
});

log.debug('discord', 'connecting to Discord gateway...');
client.login(process.env.DISCORD_TOKEN);
