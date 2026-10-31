const WHITESPACE_RUN = /\s+/g;
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

export const normalizeAnswer = (value: string) =>
  value.normalize('NFC').trim().replace(WHITESPACE_RUN, ' ').toLowerCase();

export const splitGraphemes = (value: string) =>
  Array.from(segmenter.segment(value.normalize('NFC')), (s) => s.segment);
