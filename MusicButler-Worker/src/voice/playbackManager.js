import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { discordClient } from '../discord/client.js';
import { getOpusPacketStream } from '../extraction/youtube.js';
import { PreBufferedOpusStream } from '../audio/preBuffer.js';

// One entry per guild. Single-guild deployments will only ever have one.
const sessions = new Map();

function getOrCreateSession(guildId) {
  let session = sessions.get(guildId);
  if (!session) {
    session = { connection: null, player: createAudioPlayer(), onTrackEnded: null };
    session.player.on(AudioPlayerStatus.Idle, () => {
      session.onTrackEnded?.();
    });
    session.player.on('error', (err) => {
      console.error(`[playback] player error (guild ${guildId}):`, err.message);
      session.onTrackEnded?.(err);
    });
    sessions.set(guildId, session);
  }
  return session;
}

export async function ensureConnection(guildId, channelId) {
  const session = getOrCreateSession(guildId);
  if (session.connection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    return session;
  }

  const guild = await discordClient.guilds.fetch(guildId);
  session.connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
  });
  await entersState(session.connection, VoiceConnectionStatus.Ready, 10_000);
  session.connection.subscribe(session.player);
  return session;
}

export async function playTrack(guildId, channelId, videoId, onTrackEnded) {
  const session = await ensureConnection(guildId, channelId);
  session.onTrackEnded = onTrackEnded;

  const opusStream = await getOpusPacketStream(videoId);
  const buffered = new PreBufferedOpusStream(opusStream, { startFrames: 25 });
  const resource = createAudioResource(buffered, { inputType: StreamType.Opus });
  session.player.play(resource);
}

export function skip(guildId) {
  const session = sessions.get(guildId);
  session?.player.stop(); // triggers Idle -> onTrackEnded
}

export function pause(guildId) {
  sessions.get(guildId)?.player.pause();
}

export function resume(guildId) {
  sessions.get(guildId)?.player.unpause();
}

export function leave(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  session.connection?.destroy();
  sessions.delete(guildId);
}
