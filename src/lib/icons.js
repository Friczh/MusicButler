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
};

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');
const NAMES = Object.keys(FALLBACK);

/** @type {Map<string, {id: string, name: string}>} */
const cache = new Map();

/**
 * Uploads MusicButler's custom control-panel icon set as application
 * emoji (visible to the bot in every server it's in, not just one guild)
 * if they don't already exist, and caches the results for synchronous
 * lookup via getIcon(). Call once after the client is ready; safe to call
 * again (e.g. on reconnect) -- existing emoji are reused, not duplicated.
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
