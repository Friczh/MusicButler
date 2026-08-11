'use strict';

const { resyncIcons } = require('../lib/icons');

module.exports = {
  name: 'seticons',
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const { updated, failed } = await resyncIcons(interaction.client);

    const text =
      failed.length > 0
        ? `Updated ${updated.length}, failed on: ${failed.join(', ')} (check bot logs).`
        : `Updated ${updated.length} icon${updated.length === 1 ? '' : 's'} from the bundled assets.`;
    await interaction.editReply(text);
  },
};
