// Prefer Opus-native audio-only formats so we can demux instead of
// transcode. `chooseFormat` here is used only to inspect what's actually
// available before calling `info.download()`, which is where the real
// selection + po_token gets applied.
export function selectAudioFormat(info) {
  let chosen;
  try {
    chosen = info.chooseFormat({ type: 'audio', codec: 'opus', quality: 'best' });
  } catch {
    chosen = null; // no opus audio-only format available
  }

  if (chosen) {
    return { format: chosen, isOpus: true };
  }

  const fallback = info.chooseFormat({ type: 'audio', quality: 'best' });
  return { format: fallback, isOpus: fallback?.mime_type?.includes('opus') ?? false };
}
