'use strict';

const { log } = require('./log');

// Discord's bulkDelete refuses messages older than 14 days -- confirmed
// against discord.js's ChannelManager: it filters them out itself and
// throws if ALL supplied messages fall outside the window with a plain
// array, but silently no-ops old ones when passed a Collection. Filtering
// here up front avoids relying on that implicit behavior.
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Deletes every message this bot has sent in the given channel (within the
 * last 100 messages / 14 days -- Discord API limits). Used for auto-cleanup
 * on VC leave and the manual /clearmessage command; same logic either way.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 */
async function clearBotMessages(client, channelId) {
  if (!channelId) return;

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    log.debug('cleanup', `couldn't fetch channel ${channelId}: ${err.message}`);
    return;
  }
  if (!channel?.isTextBased()) return;

  let messages;
  try {
    messages = await channel.messages.fetch({ limit: 100 });
  } catch (err) {
    log.error('cleanup', `couldn't fetch messages in ${channelId}: ${err.message}`);
    return;
  }

  const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
  const ownRecent = messages.filter((m) => m.author.id === client.user.id && m.createdTimestamp >= cutoff);
  const ownOld = messages.filter((m) => m.author.id === client.user.id && m.createdTimestamp < cutoff);

  if (ownRecent.size === 1) {
    await ownRecent.first().delete().catch(() => {});
  } else if (ownRecent.size > 1) {
    try {
      await channel.bulkDelete(ownRecent, true);
    } catch (err) {
      log.error('cleanup', `bulkDelete failed in ${channelId}: ${err.message}`);
    }
  }

  // Messages older than 14 days can't be bulk-deleted -- fall back to
  // individual deletes for those (best-effort, rate-limit friendly since
  // this is a rare cold-cleanup path, not the common case).
  for (const msg of ownOld.values()) {
    await msg.delete().catch(() => {});
  }
}

module.exports = { clearBotMessages };
