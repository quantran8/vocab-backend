import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CEFR_LEVELS, CefrLevel, PART_OF_SPEECH } from '../../common/constants/domain';
import { LEXICON_FILE } from '../paths';
import { extractedDir, sourcePath } from '../sources';
import { posForms, regularForms } from './inflect';
import { Lexicon, LexiconEntry, entryKey } from './lexicon.types';
import { cmudictIpa, DETERMINER, parseBritfone, parseCmudict, parseNgslForms, parseNgslRanks, parseProfile, parseSenseCounts, parseWordnet, ProfileRow } from './parse';

const MAX_SENSES = 15;
const levelIndex = (level: CefrLevel) => CEFR_LEVELS.indexOf(level);
const lower = (a: CefrLevel, b: CefrLevel | undefined) => (b && levelIndex(b) <= levelIndex(a) ? b : a);

export function buildLexicon(): Lexicon {
  const cefrj = parseProfile(sourcePath('cefrj')).map((r) => ({ ...r, source: 'cefrj' as const }));
  const ovp = parseProfile(sourcePath('ovp')).map((r) => ({ ...r, source: 'ovp' as const }));
  const ranks = parseNgslRanks(sourcePath('ngsl-stats'));
  const ngslForms = parseNgslForms(sourcePath('ngsl-forms'));
  const cmu = parseCmudict(sourcePath('cmudict'));
  const britfone = parseBritfone(sourcePath('britfone'));

  // The app has no determiner: a determiner joins the pronoun entry when the word is also a pronoun (more, this, some),
  // as learner dictionaries list them together. Determiner-only words (the, a, every, my) are not taught.
  const pronounLemmas = new Set([...cefrj, ...ovp].filter((r) => r.pos === PART_OF_SPEECH.PRONOUN).map((r) => r.lemma));
  const profile = [...cefrj, ...ovp].map((r) => (r.sourcePos === DETERMINER && pronounLemmas.has(r.lemma) ? { ...r, pos: PART_OF_SPEECH.PRONOUN } : r));

  // CEFR-J wins over Octanove; within one source the lowest level wins.
  const rows = new Map<string, ProfileRow & { source: 'cefrj' | 'ovp' }>();
  for (const row of profile) {
    if (!row.pos) continue;
    const key = entryKey(row.lemma, row.pos);
    const seen = rows.get(key);
    if (!seen || (seen.source === row.source && levelIndex(row.cefr) < levelIndex(seen.cefr))) rows.set(key, row);
  }

  const levelOfForm: Record<string, CefrLevel> = {};
  const note = (form: string, level: CefrLevel) => { levelOfForm[form] = lower(level, levelOfForm[form]); };
  for (const row of [...cefrj, ...ovp]) {
    for (const variant of row.variants) {
      const forms = ngslForms.get(variant) ?? (row.pos ? regularForms(variant, row.pos) : [variant]);
      for (const form of forms) note(form, row.cefr);
    }
  }

  const lemmas = new Set([...rows.values()].map((r) => r.lemma));
  const { senses, synsets } = parseWordnet(extractedDir('oewn'), extractedDir('oewn-index'), lemmas);
  const counts = parseSenseCounts(join(extractedDir('pwn'), 'dict', 'index.sense'), lemmas);

  const entries: LexiconEntry[] = [...rows.values()].map((row) => {
    const key = entryKey(row.lemma, row.pos!);
    const wordSenses = (senses.get(key) ?? [])
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_SENSES)
      .flatMap((s) => {
        const synset = synsets.get(s.synset);
        return synset ? [{ key: s.key, gloss: synset.gloss, lexname: synset.lexname, homograph: s.homograph, pronunciations: s.pronunciations, count: counts.get(s.key) ?? 0 }] : [];
      });
    return {
      key,
      lemma: row.lemma,
      pos: row.pos!,
      cefr: row.cefr,
      cefrSource: row.source,
      ngslRank: ranks.get(row.lemma) ?? null,
      forms: posForms(row.lemma, row.pos!, ngslForms.get(row.lemma)),
      senses: wordSenses,
      ipaUs: cmudictIpa(cmu.get(row.lemma) ?? []),
      ipaUk: britfone.get(row.lemma) ?? [],
      confusables: { homophones: [], spelling: [] },
    };
  });
  // A pronoun's -s form can be a pronoun of its own (it: its); that one is taught under its own entry.
  const pronouns = new Set(entries.filter((e) => e.pos === PART_OF_SPEECH.PRONOUN).map((e) => e.lemma));
  for (const e of entries) if (e.pos === PART_OF_SPEECH.PRONOUN) e.forms = e.forms.filter((f) => f === e.lemma || !pronouns.has(f));
  addConfusables(entries, cmu);

  const withLevel = new Set(entries.map((e) => e.lemma));
  return {
    builtAt: new Date().toISOString(),
    entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
    levelOfForm,
    ngslWithoutLevel: [...ranks.keys()].filter((lemma) => !withLevel.has(lemma)),
  };
}

/** Same CMUdict phones (stress ignored), or one edit apart in spelling: inputs for meaning_clash and surgery later. */
function addConfusables(entries: LexiconEntry[], cmu: Map<string, string[]>) {
  const lemmas = [...new Set(entries.map((e) => e.lemma))];
  const bySound = new Map<string, Set<string>>();
  for (const lemma of lemmas) {
    for (const phones of cmu.get(lemma) ?? []) {
      const sound = phones.replace(/\d/g, '');
      bySound.set(sound, (bySound.get(sound) ?? new Set()).add(lemma));
    }
  }
  const byDeletion = new Map<string, Set<string>>();
  for (const lemma of lemmas.filter((l) => l.length >= 4 && !l.includes(' '))) {
    for (let i = -1; i < lemma.length; i += 1) {
      const variant = i < 0 ? lemma : lemma.slice(0, i) + lemma.slice(i + 1);
      byDeletion.set(variant, (byDeletion.get(variant) ?? new Set()).add(lemma));
    }
  }
  for (const entry of entries) {
    const homophones = new Set<string>();
    for (const phones of cmu.get(entry.lemma) ?? []) for (const other of bySound.get(phones.replace(/\d/g, '')) ?? []) homophones.add(other);
    homophones.delete(entry.lemma);

    const spelling = new Set<string>();
    for (let i = -1; i < entry.lemma.length; i += 1) {
      const variant = i < 0 ? entry.lemma : entry.lemma.slice(0, i) + entry.lemma.slice(i + 1);
      for (const other of byDeletion.get(variant) ?? []) if (other !== entry.lemma && isOneEdit(entry.lemma, other)) spelling.add(other);
    }
    entry.confusables = { homophones: [...homophones].sort(), spelling: [...spelling].filter((s) => !homophones.has(s)).sort() };
  }
}

function isOneEdit(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));
    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i += 1) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

export function writeLexicon() {
  const lexicon = buildLexicon();
  mkdirSync(dirname(LEXICON_FILE), { recursive: true });
  writeFileSync(LEXICON_FILE, JSON.stringify(lexicon));
  const withSenses = lexicon.entries.filter((e) => e.senses.length > 0).length;
  const withIpa = lexicon.entries.filter((e) => e.ipaUs.length > 0).length;
  const withCounts = lexicon.entries.filter((e) => e.senses.some((s) => s.count > 0)).length;
  console.log(`lexicon: ${lexicon.entries.length} entries, ${withSenses} with WordNet senses, ${withCounts} with SemCor counts, ${withIpa} with US IPA, ${lexicon.ngslWithoutLevel.length} NGSL lemmas without level`);
}
