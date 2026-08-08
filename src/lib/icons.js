'use strict';

const path = require('path');
const { log } = require('./log');

// Fallback used if custom-emoji setup hasn't finished yet (startup race)
// or failed outright (e.g. missing permission) -- panel/queue UI still
// works, just with generic Unicode instead of the branded set.
const FALLBACK = {
  pause: '⏸️',
  play: '▶️',
  skip: '⏭️',
  stop: '⏹️',
  queue: '📜',
  add: '➕',
  back: '⏮️',
  refresh: '🔄',
  // Not wired into any UI yet -- uploaded ahead of the shuffle/repeat
  // feature so the icons are ready when that's built.
  shuffle_on: '🔀',
  shuffle_off: '🔀',
  repeat_all: '🔁',
  repeat_one: '🔂',
  repeat_off: '🔁',
};

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');
const NAMES = Object.keys(FALLBACK);

/** @type {Map<string, {id: string, name: string}>} */
const cache = new Map();

/**
 * Uploads MusicButler's custom control-panel icon set as application
 * emoji (visible to the bot in every server it's in, not just one guild).
 * Call once after the client is ready; safe to call again (e.g. on
 * reconnect).
 *
 * Always deletes and recreates each emoji rather than reusing an existing
 * one by name -- Discord's application-emoji edit endpoint only supports
 * renaming, there is NO way to update an emoji's image in place (confirmed
 * against installed source: ApplicationEmojiManager.edit() only PATCHes
 * `name`). Reuse-by-name was the original design here, and it meant
 * swapping the bundled PNG on disk silently did nothing -- the live emoji
 * stayed whatever image was uploaded the first time. Delete+recreate on
 * every startup guarantees what's live always matches what's bundled, at
 * the cost of a handful of extra API calls once per boot (cheap).
 */
async function initIcons(client) {
  const app = client.application;
  if (!app) {
    log.error('icons', 'client.application unavailable -- skipping custom icon setup');
    return;
  }

  let existing;
  try {
    existing = await app.emojis.fetch();
  } catch (err) {
    log.error('icons', `couldn't fetch application emojis: ${err.message}`);
    return;
  }

  for (const name of NAMES) {
    const emojiName = `mb_${name}`;
    const found = existing.find((e) => e.name === emojiName);
    if (found) {
      try {
        await app.emojis.delete(found.id);
      } catch (err) {
        log.error('icons', `couldn't delete stale emoji ${emojiName}: ${err.message}`);
        // Fall through to try creating anyway -- Discord allows duplicate
        // application emoji names, so a failed delete just leaves an
        // orphaned old one rather than blocking the refresh.
      }
    }
    try {
      const created = await app.emojis.create({
        attachment: path.join(ASSET_DIR, `${emojiName}.png`),
        name: emojiName,
      });
      cache.set(name, { id: created.id, name: created.name });
    } catch (err) {
      log.error('icons', `couldn't create emoji ${emojiName}: ${err.message}`);
    }
  }
}

/** Returns a {id, name} object for setEmoji() if the custom icon is ready, else a Unicode fallback string. */
function getIcon(name) {
  return cache.get(name) ?? FALLBACK[name] ?? '❔';
}

/** Same lookup, but as inline `<:name:id>` markdown for embed titles/descriptions instead of button-object form. */
function getIconText(name) {
  const icon = cache.get(name);
  return icon ? `<:${icon.name}:${icon.id}>` : (FALLBACK[name] ?? '❔');
}

module.exports = { initIcons, getIcon, getIconText };
