const HTTPS = 'https:';
const PLACEHOLDER_HOST = 'cdn.example.invalid';

// audio_asset_key already holds a playable URL; storage is handled outside this service.
export function resolveAudioUrl(assetKey: string | null | undefined, allowPlaceholder: boolean) {
  if (!assetKey) return null;
  if (!URL.canParse(assetKey)) return null;
  const url = new URL(assetKey);
  if (url.protocol !== HTTPS) return null;
  if (url.hostname === PLACEHOLDER_HOST && !allowPlaceholder) return null;
  return assetKey;
}
