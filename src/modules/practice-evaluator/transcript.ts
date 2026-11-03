const MARKS = /\p{M}/gu;
const NOT_WORD = /[^\p{L}\p{N}']+/gu;

export const normalizeTranscript = (value: string) =>
  value.normalize('NFKD').replace(MARKS, '').replace(/’/g, "'").toLowerCase().replace(NOT_WORD, ' ').trim();

/** Whether a transcript is exactly the reference; null when nothing was recognized. A transcript can't measure pronunciation, so there is no score. */
export function transcriptMatches(transcript: string, reference: string): boolean | null {
  const heard = normalizeTranscript(transcript);
  const expected = normalizeTranscript(reference);
  if (!heard || !expected) return null;
  return heard === expected;
}
