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
  back: '⏮️',
  refresh: '🔄',
  shuffle: '🔀',
  repeat_all: '🔁',
  repeat_one: '🔂',
  repeat_off: '🔁',
};

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');
const NAMES = Object.keys(FALLBACK);

/** @type {Map<string, {id: string, name: string}>} */
const cache = new Map();

/**
 * One-time setup: uploads any icon that doesn't already exist as an
 * application emoji (visible to the bot in every server it's in, not
 * just one guild) and caches the full set for synchronous lookup via
 * getIcon()/getIconText(). Safe to call on every boot -- Discord's own
 * application-emoji list IS the persistence layer here, so there's
 * nothing to survive a restart/redeploy locally; an existing emoji is
 * just reused as-is, no re-upload. Cheap after the first run: one
 * fetch() to list what's there, zero create() calls once everything
 * exists.
 *
 * This does NOT pick up a changed PNG on disk for an icon that already
 * exists as an emoji -- see resyncIcons() for that.
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
      cache.set(name, { id: found.id, name: found.name });
      continue;
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

/**
 * Forces every icon to be re-uploaded from the current bundled PNG,
 * regardless of whether an emoji with that name already exists --
 * Discord's application-emoji edit endpoint only supports renaming,
 * there is NO way to update an emoji's image in place (confirmed against
 * installed source: ApplicationEmojiManager.edit() only PATCHes `name`),
 * so picking up a redesigned icon means delete-then-create. Unlike
 * initIcons(), this is deliberately NOT run automatically on every boot
 * -- only call this when the bundled art actually changed (e.g. from a
 * manual admin command), since it's a handful of extra API calls for
 * zero benefit on every other restart.
 *
 * @returns {Promise<{ updated: string[], failed: string[] }>}
 */
async function resyncIcons(client) {
  const result = { updated: [], failed: [] };
  const app = client.application;
  if (!app) {
    log.error('icons', 'client.application unavailable -- skipping icon resync');
    return result;
  }

  let existing;
  try {
    existing = await app.emojis.fetch();
  } catch (err) {
    log.error('icons', `couldn't fetch application emojis: ${err.message}`);
    return result;
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
      result.updated.push(name);
    } catch (err) {
      log.error('icons', `couldn't create emoji ${emojiName}: ${err.message}`);
      result.failed.push(name);
    }
  }

  return result;
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

module.exports = { initIcons, resyncIcons, getIcon, getIconText };
