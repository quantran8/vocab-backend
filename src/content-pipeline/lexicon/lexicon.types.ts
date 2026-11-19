import { CefrLevel, PartOfSpeech } from '../../common/constants/domain';

export interface LexiconSense {
  /** WordNet sense key, e.g. bank%1:14:00:: */
  key: string;
  gloss: string;
  lexname: string;
  /** OEWN homograph number when the spelling has several entries in this part of speech. */
  homograph: string | null;
  /** OEWN IPA without slashes, set on homographs. */
  pronunciations: string[];
  /** Times the sense is tagged in SemCor (Princeton WordNet 3.0); 0 when untagged. */
  count: number;
}

export interface LexiconEntry {
  /** `${lemma}|${pos}` */
  key: string;
  lemma: string;
  pos: PartOfSpeech;
  cefr: CefrLevel;
  cefrSource: 'cefrj' | 'ovp';
  ngslRank: number | null;
  forms: string[];
  /** Most frequent first, as WordNet orders them. */
  senses: LexiconSense[];
  ipaUs: string[];
  /** Britfone notation (ɹ, ɛ, stress before the vowel); normalize before storing. */
  ipaUk: string[];
  confusables: { homophones: string[]; spelling: string[] };
}

export interface Lexicon {
  builtAt: string;
  entries: LexiconEntry[];
  /** Lowest CEFR level of every known word form, function words included. */
  levelOfForm: Record<string, CefrLevel>;
  /** NGSL lemmas with no CEFR-J/OVP row in a supported part of speech. */
  ngslWithoutLevel: string[];
}

export const entryKey = (lemma: string, pos: string) => `${lemma}|${pos}`;
