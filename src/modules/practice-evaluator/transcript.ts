const MARKS = /\p{M}/gu;
const NOT_WORD = /[^\p{L}\p{N}']+/gu;

export const normalizeTranscript = (value: string) =>
  value.normalize('NFKD').replace(MARKS, '').replace(/’/g, "'").toLowerCase().replace(NOT_WORD, ' ').trim();

function editDistance(a: string[], b: string[]) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** 0-100 similarity of a transcript to the reference; null when nothing was recognized. */
export function transcriptScore(transcript: string, reference: string): number | null {
  const heard = Array.from(normalizeTranscript(transcript));
  const expected = Array.from(normalizeTranscript(reference));
  if (heard.length === 0 || expected.length === 0) return null;
  const longest = Math.max(heard.length, expected.length);
  return Math.round((1 - editDistance(heard, expected) / longest) * 100);
}
