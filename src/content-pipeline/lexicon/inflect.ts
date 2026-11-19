import { PART_OF_SPEECH, PartOfSpeech } from '../../common/constants/domain';

const VOWEL = /[aeiou]/;

/** Regular inflections only; a superset is fine because it is used for lookups, never shown. */
export function regularForms(lemma: string, pos: PartOfSpeech): string[] {
  if (lemma.includes(' ')) return [lemma];
  const forms = new Set([lemma]);
  const last = lemma.slice(-1);
  const stem = lemma.slice(0, -1);
  const sibilant = /(s|x|z|ch|sh)$/.test(lemma);
  const consonantY = last === 'y' && !VOWEL.test(lemma.at(-2) ?? '');
  const plural = consonantY ? `${stem}ies` : sibilant ? `${lemma}es` : `${lemma}s`;

  if (pos === PART_OF_SPEECH.NOUN || pos === PART_OF_SPEECH.VERB) forms.add(plural);
  if (pos === PART_OF_SPEECH.VERB) {
    const doubled = /[^aeiou][aeiou][bdgklmnprt]$/.test(lemma) ? lemma + last : lemma;
    forms.add(consonantY ? `${stem}ied` : last === 'e' ? `${lemma}d` : `${lemma}ed`);
    forms.add(`${doubled}ed`);
    forms.add(last === 'e' && !lemma.endsWith('ee') ? `${stem}ing` : `${lemma}ing`);
    forms.add(`${doubled}ing`);
  }
  if (pos === PART_OF_SPEECH.ADJECTIVE) {
    forms.add(consonantY ? `${stem}ier` : last === 'e' ? `${lemma}r` : `${lemma}er`);
    forms.add(consonantY ? `${stem}iest` : last === 'e' ? `${lemma}st` : `${lemma}est`);
  }
  return [...forms];
}

const IRREGULAR_PLURALS = new Set(['men', 'women', 'children', 'feet', 'teeth', 'mice', 'geese', 'people', 'data', 'criteria', 'phenomena', 'media']);
const IRREGULAR_DEGREES = new Set(['better', 'best', 'worse', 'worst', 'more', 'most', 'less', 'least', 'further', 'furthest', 'farther', 'farthest', 'elder', 'eldest']);
const VERB_S_FORMS = new Set(['has', 'does', 'is', 'goes']);
const INFORMAL = new Set(['gonna', 'wanna', 'gotta', 'goin', 'im']);
const DERIVED = /(ings|ers?|ness|ments?|tions?|ly|ful|able)$/;

/**
 * Forms that count as this headword in this part of speech. NGSL lists one word family for every part of speech
 * (time: timing; I: me, my), so its forms are narrowed here.
 */
export function posForms(lemma: string, pos: PartOfSpeech, family: string[] = []): string[] {
  const regular = regularForms(lemma, pos);
  const others = family.filter((f) => f !== lemma && !INFORMAL.has(f));
  const kept = (() => {
    switch (pos) {
      case PART_OF_SPEECH.NOUN: return others.filter((f) => IRREGULAR_PLURALS.has(f) || (f.endsWith('s') && !f.endsWith('ings') && f.startsWith(lemma.slice(0, -1))));
      // A verb form ending in -s is its third person (goes, has); anything else in -s is a noun (thoughts).
      case PART_OF_SPEECH.VERB: return others.filter((f) => regular.includes(f) || (!DERIVED.test(f) && (!f.endsWith('s') || VERB_S_FORMS.has(f))));
      case PART_OF_SPEECH.PRONOUN: return others.filter((f) => f === `${lemma}s`);
      case PART_OF_SPEECH.ADJECTIVE:
      case PART_OF_SPEECH.ADVERB: return others.filter((f) => IRREGULAR_DEGREES.has(f) || (/(er|est)$/.test(f) && f.startsWith(lemma.slice(0, -1))));
      default: return [];
    }
  })();
  const own = pos === PART_OF_SPEECH.ADVERB ? [lemma] : regular;
  return [...new Set([...own, ...kept])];
}
