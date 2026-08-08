'use strict';

const { log } = require('./log');

// Discord's bulkDelete refuses messages older than 14 days -- confirmed
// against discord.js's ChannelManager: it filters them out itself and
// throws if ALL supplied messages fall outside the window with a plain
// array, but silently no-ops old ones when passed a Collection. Filtering
// here up front avoids relying on that implicit behavior.
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Safety cap on how many 100-message pages to walk back through when
// scanning full channel history, so a channel with years of history can't
// turn one cleanup call into an unbounded crawl. 50 pages = 5000 messages.
const MAX_PAGES = 50;

/** Deletes one page's worth of the bot's own messages. Mutates `result`. */
async function deleteOwnMessages(channel, ownMessages, result) {
  const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
  const recent = ownMessages.filter((m) => m.createdTimestamp >= cutoff);
  const old = ownMessages.filter((m) => m.createdTimestamp < cutoff);

  if (recent.size === 1) {
    const ok = await recent
      .first()
      .delete()
      .then(() => true)
      .catch(() => false);
    ok ? result.deleted++ : result.failed++;
  } else if (recent.size > 1) {
    try {
      await channel.bulkDelete(recent, true);
      result.deleted += recent.size;
    } catch (err) {
      // Most commonly Missing Permissions (Manage Messages) -- fall back
      // to individual deletes, which only require deleting your own
      // message and no special permission. Slower, but doesn't leave the
      // whole batch stranded just because the bulk path is blocked.
      log.error('cleanup', `bulkDelete failed in ${channel.id} (${err.message}), falling back to individual deletes`);
      for (const msg of recent.values()) {
        const ok = await msg
          .delete()
          .then(() => true)
          .catch(() => false);
        ok ? result.deleted++ : result.failed++;
      }
    }
  }

  // Messages older than 14 days can't be bulk-deleted -- individual
  // deletes have no such age limit.
  for (const msg of old.values()) {
    const ok = await msg
      .delete()
      .then(() => true)
      .catch(() => false);
    ok ? result.deleted++ : result.failed++;
  }
}

/**
 * Deletes every message this bot has ever sent in the given channel, not
 * just the most recent 100 -- walks the full channel history backwards in
 * 100-message pages (via `before`) until it runs out of messages or hits
 * the MAX_PAGES safety cap. Used for auto-cleanup on VC leave and the
 * manual /clearmessage command; same logic either way.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @returns {Promise<{ deleted: number, failed: number }>}
 */
async function clearBotMessages(client, channelId) {
  const result = { deleted: 0, failed: 0 };
  if (!channelId) return result;

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    log.debug('cleanup', `couldn't fetch channel ${channelId}: ${err.message}`);
    return result;
  }
  if (!channel?.isTextBased()) return result;

  let before;
  for (let page = 0; page < MAX_PAGES; page++) {
    let messages;
    try {
      messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    } catch (err) {
      log.error('cleanup', `couldn't fetch messages in ${channelId}: ${err.message}`);
      break;
    }
    if (messages.size === 0) break;

    const ownMessages = messages.filter((m) => m.author.id === client.user.id);
    if (ownMessages.size > 0) {
      await deleteOwnMessages(channel, ownMessages, result);
    }

    if (messages.size < 100) break; // reached the start of the channel
    before = messages.last().id;
  }

  if (result.failed > 0) {
    log.error('cleanup', `${result.failed} message(s) in ${channelId} could not be deleted (permissions?)`);
  }

  return result;
}

module.exports = { clearBotMessages };
