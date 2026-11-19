import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CEFR_LEVELS, CefrLevel, PART_OF_SPEECH, PartOfSpeech } from '../../common/constants/domain';
import { arpabetToIpa, britfoneToIpa } from './arpabet';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

// CEFR-J parts of speech the app can teach; numbers, auxiliaries and determiners only count for level lookups here
// (determiners are merged in build-lexicon.ts).
export const DETERMINER = 'determiner';
const PROFILE_POS: Record<string, PartOfSpeech> = {
  noun: PART_OF_SPEECH.NOUN,
  verb: PART_OF_SPEECH.VERB,
  adjective: PART_OF_SPEECH.ADJECTIVE,
  adverb: PART_OF_SPEECH.ADVERB,
  pronoun: PART_OF_SPEECH.PRONOUN,
  preposition: PART_OF_SPEECH.PREPOSITION,
  conjunction: PART_OF_SPEECH.CONJUNCTION,
  interjection: PART_OF_SPEECH.INTERJECTION,
};

export interface ProfileRow { lemma: string; variants: string[]; sourcePos: string; pos: PartOfSpeech | null; cefr: CefrLevel }

/** CEFR-J and Octanove share the layout headword,pos,CEFR; a headword may list variants as a/b/c. */
export function parseProfile(path: string): ProfileRow[] {
  const [, ...rows] = parseCsv(readFileSync(path, 'utf8'));
  return rows.flatMap(([headword, sourcePos, cefr]) => {
    const level = cefr?.trim().toUpperCase() as CefrLevel;
    if (!(CEFR_LEVELS as readonly string[]).includes(level)) return [];
    const variants = headword.split('/').map((v) => v.trim()).filter(Boolean);
    const pos = sourcePos.trim().toLowerCase();
    return [{ lemma: variants[0].toLowerCase(), variants: variants.map((v) => v.toLowerCase()), sourcePos: pos, pos: PROFILE_POS[pos] ?? null, cefr: level }];
  });
}

export function parseNgslRanks(path: string): Map<string, number> {
  const [, ...rows] = parseCsv(readFileSync(path, 'utf8'));
  return new Map(rows.map(([lemma, rank]) => [lemma.trim().toLowerCase(), Number(rank)]));
}

/** Headword first, then its inflections; `##` lines are notes. */
export function parseNgslForms(path: string): Map<string, string[]> {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  return new Map(lines.map((line) => {
    const forms = line.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
    return [forms[0], forms];
  }));
}

export function parseCmudict(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([^\s(]+)(?:\(\d+\))?\s+([^#]+)/.exec(line);
    if (!match) continue;
    const word = match[1].toLowerCase();
    out.set(word, [...(out.get(word) ?? []), match[2].trim()]);
  }
  return out;
}

export const cmudictIpa = (arpabets: string[]) => [...new Set(arpabets.map(arpabetToIpa))];

export function parseBritfone(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const comma = line.indexOf(',');
    if (comma <= 0) continue;
    const word = line.slice(0, comma).replace(/\(\d+\)$/, '').trim().toLowerCase();
    const ipa = britfoneToIpa(line.slice(comma + 1));
    out.set(word, [...new Set([...(out.get(word) ?? []), ipa])]);
  }
  return out;
}

interface OewnEntry { sense: { id: string; synset: string }[]; pronunciation?: { value: string; variety?: string }[] }

const WORDNET_POS: Record<string, PartOfSpeech> = {
  n: PART_OF_SPEECH.NOUN, v: PART_OF_SPEECH.VERB, a: PART_OF_SPEECH.ADJECTIVE, s: PART_OF_SPEECH.ADJECTIVE, r: PART_OF_SPEECH.ADVERB,
};

export interface WordnetSense { key: string; synset: string; pos: PartOfSpeech; order: number; homograph: string | null; pronunciations: string[] }

/** Senses of the wanted lemmas only; the full OEWN is too large to keep in the lexicon. */
export function parseWordnet(dir: string, indexDir: string, lemmas: Set<string>) {
  const senseNumber = new Map<string, number>();
  for (const line of readFileSync(join(indexDir, 'index.sense'), 'utf8').split('\n')) {
    const [key, , number] = line.split(' ');
    if (key && lemmas.has(key.slice(0, key.indexOf('%')))) senseNumber.set(key, Number(number));
  }

  const senses = new Map<string, WordnetSense[]>();
  const files = readdirSync(dir);
  for (const file of files.filter((f) => f.startsWith('entries-'))) {
    const entries = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, Record<string, OewnEntry>>;
    for (const [lemma, byPos] of Object.entries(entries)) {
      if (!lemmas.has(lemma)) continue;
      // Homographs are keyed n-1, n-2 and carry their own pronunciation (lead /liːd/ vs /led/).
      for (const [posKey, { sense, pronunciation }] of Object.entries(byPos)) {
        const [wnPos, homograph] = posKey.split('-');
        const pos = WORDNET_POS[wnPos];
        if (!pos) continue;
        const pronunciations = (pronunciation ?? []).filter((p) => !p.variety || p.variety === 'GB' || p.variety === 'US').map((p) => p.value);
        const list = senses.get(`${lemma}|${pos}`) ?? [];
        list.push(...sense.map((s) => ({
          key: s.id, synset: s.synset, pos, order: senseNumber.get(s.id) ?? 999, homograph: homograph ?? null, pronunciations,
        })));
        senses.set(`${lemma}|${pos}`, list);
      }
    }
  }

  const wanted = new Set([...senses.values()].flat().map((s) => s.synset));
  const synsets = new Map<string, { gloss: string; lexname: string }>();
  for (const file of files.filter((f) => /^(noun|verb|adj|adv)\./.test(f))) {
    const lexname = file.replace(/\.json$/, '');
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, { definition: string[] }>;
    for (const [id, synset] of Object.entries(data)) {
      if (wanted.has(id)) synsets.set(id, { gloss: synset.definition[0] ?? '', lexname });
    }
  }
  return { senses, synsets };
}

/** SemCor tag counts by sense key; OEWN zeroed them, Princeton WordNet 3.0 still has them. */
export function parseSenseCounts(path: string, lemmas: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [key, , , count] = line.split(' ');
    if (key && Number(count) > 0 && lemmas.has(key.slice(0, key.indexOf('%')))) out.set(key, Number(count));
  }
  return out;
}
