'use strict';

const { getIconText } = require('../lib/icons');

const LABELS = { off: 'Off', all: 'Repeat all', one: 'Repeat one' };

module.exports = {
  name: 'repeat',
  async execute(interaction, { playerManager }) {
    const mode = interaction.options.getString('mode', true);
    const player = playerManager.get(interaction.guildId);
    const applied = player.queue.setRepeatMode(mode);

    await interaction.reply({
      content: `${getIconText(`repeat_${applied}`)} Repeat: **${LABELS[applied]}**`,
      ephemeral: true,
    });

    // Panel isn't reposted for this -- just reflects the new mode in
    // place, same as pause/resume/queue-add.
    player.refreshPanel();
  },
};
