'use strict';

const {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const { buildPanelEmbed, buildPanelComponents } = require('./panel');
const { getIconText } = require('./icons');
const { log } = require('./log');

const PLAY_MODAL_ID = 'panel_play_modal';
const PLAY_MODAL_INPUT_ID = 'panel_play_query';
const QUEUE_LIST_LIMIT = 25;

function buildQueueEmbed(queue) {
  const tracks = queue.list();
  const lines = tracks.slice(0, QUEUE_LIST_LIMIT).map((t, i) => `**${i + 1}.** ${t.title}`);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${getIconText('queue')} Queue`)
    .setDescription(lines.length ? lines.join('\n') : '*(empty)*');
  if (tracks.length > QUEUE_LIST_LIMIT) {
    embed.setFooter({ text: `+ ${tracks.length - QUEUE_LIST_LIMIT} more — use /queue list to page through` });
  }
  if (queue.playing) {
    embed.addFields({ name: `${getIconText('play')} Now playing`, value: queue.playing.title });
  }
  return embed;
}

/**
 * Handles every panel_* button and the Play modal submit. Returns true if
 * it handled the interaction, false otherwise (so index.js's dispatcher
 * knows whether to fall through).
 */
async function handlePanelInteraction(interaction, ctx) {
  const { playerManager } = ctx;

  if (interaction.isButton() && interaction.customId.startsWith('panel_')) {
    const player = playerManager.get(interaction.guildId);

    switch (interaction.customId) {
      case 'panel_pauseresume': {
        if (!player.connection || !player.queue.playing) {
          await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
          return true;
        }
        const wasPaused = player.isPaused();
        const ok = wasPaused ? player.resume() : player.pause();
        if (!ok) {
          await interaction.reply({ content: "Couldn't update playback.", ephemeral: true });
          return true;
        }
        // Immediate edit on the interaction itself -- silent, no new
        // message. player.pause()/resume() also schedule their own
        // fire-and-forget edit-in-place; harmless overlap, this one just
        // responds within Discord's 3s ack window without waiting on it.
        const isPaused = !wasPaused;
        await interaction.update({
          embeds: [buildPanelEmbed({ track: player.queue.playing, queueLength: player.queue.list().length, isPaused, repeatMode: player.queue.repeatMode, shuffleActive: player.queue.shuffleActive })],
          components: buildPanelComponents({ isPaused, repeatMode: player.queue.repeatMode, shuffleActive: player.queue.shuffleActive }),
        });
        return true;
      }

      case 'panel_skip': {
        if (!player.connection || !player.queue.playing) {
          await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
          return true;
        }
        player.skip();
        // Panel repost happens automatically once the next track starts
        // (or edits to idle state if the queue is now empty) -- see
        // player.js's _playNext(). Just ack the click silently.
        await interaction.deferUpdate();
        return true;
      }

      case 'panel_stop': {
        if (!playerManager.has(interaction.guildId)) {
          await interaction.reply({ content: 'Not connected to a voice channel.', ephemeral: true });
          return true;
        }
        await interaction.deferUpdate();
        // Deletes the panel message (this one included) along with every
        // other bot message in the channel -- see disconnect() in player.js.
        playerManager.delete(interaction.guildId);
        return true;
      }

      case 'panel_queue': {
        await interaction.reply({ embeds: [buildQueueEmbed(player.queue)], ephemeral: true });
        return true;
      }

      case 'panel_play': {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
          await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
          return true;
        }
        const modal = new ModalBuilder().setCustomId(PLAY_MODAL_ID).setTitle('Play');
        const input = new TextInputBuilder()
          .setCustomId(PLAY_MODAL_INPUT_ID)
          .setLabel('URL or search terms')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
      }

      case 'panel_repeat': {
        const mode = player.cycleRepeatMode();
        await interaction.update({
          embeds: [
            buildPanelEmbed({
              track: player.queue.playing,
              queueLength: player.queue.list().length,
              isPaused: player.isPaused(),
              repeatMode: mode,
              shuffleActive: player.queue.shuffleActive,
            }),
          ],
          components: buildPanelComponents({ isPaused: player.isPaused(), repeatMode: mode, shuffleActive: player.queue.shuffleActive }),
        });
        return true;
      }

      case 'panel_shuffle': {
        const result = player.queue.toggleShuffle();
        const { shuffleReplyText } = require('../commands/shuffle');
        // Persistent toggle now, unlike the other buttons here -- update
        // the panel in place so the embed/button reflect the new state,
        // same pattern as panel_repeat.
        await interaction.update({
          embeds: [
            buildPanelEmbed({
              track: player.queue.playing,
              queueLength: player.queue.list().length,
              isPaused: player.isPaused(),
              repeatMode: player.queue.repeatMode,
              shuffleActive: result.active,
            }),
          ],
          components: buildPanelComponents({ isPaused: player.isPaused(), repeatMode: player.queue.repeatMode, shuffleActive: result.active }),
        });
        await interaction.followUp({ content: shuffleReplyText(result), ephemeral: true });
        return true;
      }

      default:
        return false;
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === PLAY_MODAL_ID) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });
    const query = interaction.fields.getTextInputValue(PLAY_MODAL_INPUT_ID);

    // Lazy require avoids a circular dependency (play.js doesn't need to
    // know about panels/modals).
    const { resolveAndQueue } = require('../commands/play');
    const result = await resolveAndQueue(query, {
      voiceChannel,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      requestedBy: interaction.user.id,
      playerManager,
    });

    await interaction.editReply(result.ok ? result.replyText : result.errorText).catch((err) =>
      log.error('panel', `modal reply failed: ${err.message}`)
    );
    return true;
  }

  return false;
}

module.exports = { handlePanelInteraction };
