import { createHash } from 'node:crypto';

const CURLY_APOSTROPHE = /[‘’]/g;

/** Must stay equivalent to lower(btrim(lemma)) in the words unique index. */
export const normalizeText = (text: string) =>
  text.normalize('NFC').replace(CURLY_APOSTROPHE, "'").replace(/\s+/g, ' ').trim().toLowerCase();

// Per user: a draft shaped by someone's own words is never served to anyone else.
export const contextKey = (userId: string, context: string) => `sense:${userId}:${createHash('sha256').update(normalizeText(context)).digest('hex')}`;

export const translationKey = (meaningId: string) => `meaning:${meaningId}`;

/** IPA without the /slashes/ or [brackets] editors may type; null when nothing is left. */
export const bareIpa = (ipa: string | null | undefined) => ipa?.normalize('NFC').trim().replace(/^[/[]+|[/\]]+$/g, '').trim() || null;

// Keyed by sound, not spelling: "read" (past) and "red" share /rɛd/. The key never reveals the word.
export const audioKey = (voice: string, accent: string, ipa: string) =>
  `tts/${voice}/${accent}/${createHash('sha256').update(ipa).digest('hex')}.mp3`;

export function locateTarget(text: string, target: string) {
  const start = text.toLowerCase().indexOf(target.trim().toLowerCase());
  return start < 0 || !target.trim() ? null : { start, end: start + target.trim().length };
}
