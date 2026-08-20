'use strict';

const { YTNodes } = require('youtubei.js');

const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);
const MUSIC_HOSTS = new Set(['music.youtube.com']);

/**
 * @param {string} input
 * @returns {{ videoId: string, isMusic: boolean } | null}
 */
function parseVideoIdFromUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null; // not a URL at all -> treat as a search query upstream
  }

  const host = url.hostname.toLowerCase();
  const isMusic = MUSIC_HOSTS.has(host);
  const isYouTube = YOUTUBE_HOSTS.has(host) || isMusic;
  if (!isYouTube) return null;

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id ? { videoId: id, isMusic: false } : null;
  }

  const vParam = url.searchParams.get('v');
  if (vParam) return { videoId: vParam, isMusic };

  const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
  if (shortsMatch) return { videoId: shortsMatch[1], isMusic };

  const embedMatch = url.pathname.match(/^\/embed\/([^/]+)/);
  if (embedMatch) return { videoId: embedMatch[1], isMusic };

  return null;
}

/**
 * Classifies a /play argument before any resolution happens, so playlist
 * and radio URLs can be routed differently from single videos.
 *
 * Radio/mix URLs (list=RD...) are treated as a single video via the
 * URL's `v=` anchor id instead of playlist expansion. RD-prefix as the
 * radio/mix marker is standard convention, not verified live here --
 * sanity-check against real radio links before relying on it.
 *
 * @param {string} input
 * @returns {
 *   | { kind: 'playlist', playlistId: string, isMusic: boolean }
 *   | { kind: 'video', videoId: string, isMusic: boolean }
 *   | { kind: 'search', query: string }
 *   | { kind: 'unsupported', reason: string }
 * }
 */
function classifyInput(input) {
  const trimmed = input.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: 'search', query: trimmed };
  }

  const host = url.hostname.toLowerCase();
  const isMusic = MUSIC_HOSTS.has(host);
  if (!YOUTUBE_HOSTS.has(host) && !isMusic) {
    return { kind: 'search', query: trimmed };
  }

  const listParam = url.searchParams.get('list');
  if (listParam) {
    if (listParam.startsWith('RD')) {
      const anchorVideoId = url.searchParams.get('v');
      if (anchorVideoId) {
        return { kind: 'video', videoId: anchorVideoId, isMusic };
      }
      return { kind: 'unsupported', reason: 'radio_without_anchor' };
    }
    return { kind: 'playlist', playlistId: listParam, isMusic };
  }

  const direct = parseVideoIdFromUrl(trimmed);
  if (direct) {
    return { kind: 'video', videoId: direct.videoId, isMusic: direct.isMusic };
  }

  return { kind: 'search', query: trimmed };
}

/**
 * Resolves a /play argument (URL or free-text query) to a video ID.
 * @param {import('youtubei.js').Innertube} session
 * @param {string} query
 * @returns {Promise<{ videoId: string, isMusic: boolean, title: string, duration: number }>}
 */
async function resolveQuery(session, query) {
  const direct = parseVideoIdFromUrl(query.trim());
  if (direct) {
    // getBasicInfo()/getInfo() hardcode a cast that throws on a YTM
    // response shape -- music.getInfo() is the method built for it.
    const info = direct.isMusic
      ? await session.music.getInfo(direct.videoId)
      : await session.getBasicInfo(direct.videoId);
    return {
      videoId: direct.videoId,
      isMusic: direct.isMusic,
      title: info.basic_info.title ?? direct.videoId,
      duration: info.basic_info.duration ?? 0,
    };
  }

  const results = await session.search(query, { type: 'video' });
  const firstVideo = results.results.firstOfType(YTNodes.Video);
  if (!firstVideo) {
    throw new Error(`No results found for "${query}"`);
  }
  return {
    videoId: firstVideo.video_id,
    isMusic: false,
    title: firstVideo.title?.text ?? firstVideo.video_id,
    // Video node's duration is { text, seconds }, unlike the plain int above.
    duration: firstVideo.duration?.seconds ?? 0,
  };
}

/**
 * Fetches every track's metadata (id + title) for a playlist up front, so
 * the queue can be listed immediately. Audio extraction stays lazy, per
 * track, in player.js. YouTube and YT Music use different playlist
 * endpoints/item shapes, handled explicitly rather than assumed shared.
 *
 * @param {import('youtubei.js').Innertube} session
 * @param {string} playlistId
 * @param {boolean} isMusic
 * @param {{ maxTracks?: number }} [opts]
 * @returns {Promise<Array<{ videoId: string, isMusic: boolean, title: string, duration: number }>>}
 */
async function resolvePlaylistTracks(session, playlistId, isMusic, { maxTracks = Infinity } = {}) {
  const tracks = [];

  if (isMusic) {
    let playlist = await session.music.getPlaylist(playlistId);
    while (tracks.length < maxTracks) {
      const items = playlist.items?.filterType(YTNodes.MusicResponsiveListItem) ?? [];
      for (const item of items) {
        if (tracks.length >= maxTracks) break;
        const playable = item.item_type === 'song' || item.item_type === 'video';
        if (!playable || !item.id) continue; // skip unavailable / non-track entries
        // { text, seconds } shape, same as PlaylistVideo below.
        tracks.push({ videoId: item.id, isMusic: true, title: item.title ?? item.id, duration: item.duration?.seconds ?? 0 });
      }
      if (tracks.length >= maxTracks || !playlist.has_continuation) break;
      playlist = await playlist.getContinuation();
    }
    return tracks;
  }

  let playlist = await session.getPlaylist(playlistId);
  while (tracks.length < maxTracks) {
    const items = playlist.items.filterType(YTNodes.PlaylistVideo);
    for (const item of items) {
      if (tracks.length >= maxTracks) break;
      if (!item.is_playable) continue; // skip private/deleted/region-locked placeholders
      tracks.push({ videoId: item.id, isMusic: false, title: item.title?.text ?? item.id, duration: item.duration?.seconds ?? 0 });
    }
    if (tracks.length >= maxTracks || !playlist.has_continuation) break;
    playlist = await playlist.getContinuation();
  }
  return tracks;
}

module.exports = { parseVideoIdFromUrl, classifyInput, resolveQuery, resolvePlaylistTracks };
