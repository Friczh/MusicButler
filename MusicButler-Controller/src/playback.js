import { queueManager } from './queue/queueManager.js';
import {
  startControlClient,
  sendPlay,
  sendSkip,
  sendPause,
  sendResume,
  sendLeave,
  startHeartbeat,
} from './ws/controlClient.js';

export class Playback {
  constructor() {
    this.guildId = null;
    this.channelId = null;

    startControlClient({
      onTrackEnded: (guildId) => this._playNext(guildId),
      onError: (guildId, message) => console.error(`[playback] Worker error (guild ${guildId}):`, message),
      onStarted: (guildId) => console.log(`[playback] track started (guild ${guildId})`),
    });

    this._stopHeartbeat = startHeartbeat((err) => {
      console.error('[worker] unhealthy:', err?.message);
    });
  }

  ensurePlaying(interaction) {
    const channel = interaction.member.voice.channel;
    if (!channel) throw new Error('You must be in a voice channel.');

    this.guildId = interaction.guildId;
    this.channelId = channel.id;

    if (!queueManager.nowPlaying) {
      this._playNext(this.guildId);
    }
  }

  _playNext(guildId) {
    const track = queueManager.advance();
    if (!track) return;
    sendPlay(guildId, this.channelId, track.videoId);
  }

  skip() {
    sendSkip(this.guildId);
  }

  pause() {
    sendPause(this.guildId);
  }

  resume() {
    sendResume(this.guildId);
  }

  leave() {
    sendLeave(this.guildId);
    queueManager.clear();
  }
}
