// CMUdict ARPAbet to the dictionary-style US IPA the app already uses (/ˈdɑːktər/).
const VOWELS: Record<string, [stressed: string, unstressed: string]> = {
  AA: ['ɑː', 'ɑː'], AE: ['æ', 'æ'], AH: ['ʌ', 'ə'], AO: ['ɔː', 'ɔː'], AW: ['aʊ', 'aʊ'], AY: ['aɪ', 'aɪ'],
  EH: ['e', 'e'], ER: ['ɜːr', 'ər'], EY: ['eɪ', 'eɪ'], IH: ['ɪ', 'ɪ'], IY: ['iː', 'i'], OW: ['oʊ', 'oʊ'],
  OY: ['ɔɪ', 'ɔɪ'], UH: ['ʊ', 'ʊ'], UW: ['uː', 'u'],
};
const CONSONANTS: Record<string, string> = {
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ',
  P: 'p', R: 'r', S: 's', SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};
// Maximal onset: the longest consonant cluster that can start an English syllable joins the next vowel.
const ONSETS = new Set([
  'P R', 'P L', 'B R', 'B L', 'T R', 'D R', 'K R', 'K L', 'G R', 'G L', 'F R', 'F L', 'TH R', 'SH R', 'S P', 'S T', 'S K',
  'S M', 'S N', 'S L', 'S W', 'S P R', 'S P L', 'S T R', 'S K R', 'S K W', 'K W', 'T W', 'D W', 'G W', 'TH W', 'P Y',
  'B Y', 'K Y', 'F Y', 'M Y', 'V Y', 'HH Y', 'S K Y',
]);

const isVowel = (phone: string) => /\d$/.test(phone);

export function arpabetToIpa(arpabet: string): string {
  const phones = arpabet.trim().split(/\s+/);
  const vowelAt = phones.flatMap((p, i) => (isVowel(p) ? [i] : []));
  // Index where each syllable starts, chosen by maximal onset between consecutive vowels.
  const starts = new Map<number, string>();
  vowelAt.forEach((v, n) => {
    const previous = n === 0 ? -1 : vowelAt[n - 1];
    let start = previous + 1;
    if (n > 0) {
      const cluster = phones.slice(previous + 1, v);
      start = v;
      for (let len = cluster.length; len > 0; len -= 1) {
        const onset = cluster.slice(cluster.length - len).join(' ');
        if (len === 1 || ONSETS.has(onset)) { start = v - len; break; }
      }
    } else {
      start = 0;
    }
    const stress = phones[v].slice(-1);
    starts.set(start, stress === '1' ? 'ˈ' : stress === '2' && vowelAt.length > 1 ? 'ˌ' : '');
  });

  const out = phones.map((phone, i) => {
    const mark = starts.get(i) ?? '';
    if (!isVowel(phone)) return mark + (CONSONANTS[phone] ?? '');
    const [stressed, unstressed] = VOWELS[phone.slice(0, -1)] ?? ['', ''];
    return mark + (phone.endsWith('0') ? unstressed : stressed);
  });
  // A single-syllable word carries no stress mark.
  const ipa = out.join('');
  return `/${vowelAt.length === 1 ? ipa.replace('ˈ', '') : ipa}/`;
}

/** Britfone writes space-separated IPA with the stress mark before the vowel. */
export function britfoneToIpa(phones: string): string {
  return `/${phones.trim().split(/\s+/).join('')}/`;
}
