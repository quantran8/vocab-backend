import { createHash } from 'node:crypto';

const CURLY_APOSTROPHE = /[‘’]/g;

/** Must stay equivalent to lower(btrim(lemma)) in the words unique index. */
export const normalizeText = (text: string) =>
  text.normalize('NFC').replace(CURLY_APOSTROPHE, "'").replace(/\s+/g, ' ').trim().toLowerCase();

// Per user: a draft shaped by someone's own words is never served to anyone else.
export const contextKey = (userId: string, context: string) => `sense:${userId}:${createHash('sha256').update(normalizeText(context)).digest('hex')}`;

export const translationKey = (meaningId: string) => `meaning:${meaningId}`;

export const audioKey = (voice: string, accent: string, text: string) =>
  `tts/${voice}/${accent}/${createHash('sha256').update(normalizeText(text)).digest('hex')}.mp3`;

export function locateTarget(text: string, target: string) {
  const start = text.toLowerCase().indexOf(target.trim().toLowerCase());
  return start < 0 || !target.trim() ? null : { start, end: start + target.trim().length };
}
