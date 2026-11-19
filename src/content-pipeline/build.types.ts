import { CefrLevel, PartOfSpeech } from '../common/constants/domain';

export interface GeneratedExample {
  exampleId: string;
  text: string;
  start: number;
  end: number;
}

export interface GeneratedMeaning {
  meaningId: string;
  senseKeys: string[];
  cefrLevel: CefrLevel;
  /** English short gloss: the en-US meaningText. */
  gloss: string;
  /** English one-sentence definition: core_definition. */
  definition: string;
  ipaUs: string;
  topic: string;
  examples: GeneratedExample[];
}

/** One line of generated.jsonl: the AI output for one lemma in one part of speech, with stable ids. */
export interface GeneratedEntry {
  key: string;
  lemma: string;
  pos: PartOfSpeech;
  promptVersion: number;
  model: string;
  generatedAt: string;
  /** Why the model judged this entry not worth teaching; meanings is then empty. */
  skipped: string | null;
  meanings: GeneratedMeaning[];
  /** Rule failures found when the entry was written; such meanings are not loaded. */
  issues: Record<string, string[]>;
  /** Generations under this prompt version, counting reviewer-requested redos. */
  attempts?: number;
}

export interface ReviewProblem { key: string; gloss: string | null; kind: string; note: string }

/** One line of reviews.jsonl: a second model's verdict on one entry. `sourceHash` ties it to the reviewed content. */
export interface EntryReview {
  key: string;
  sourceHash: string;
  problems: ReviewProblem[];
  model: string;
}

/** One line of translations/<locale>.jsonl. `sourceHash` ties it to the English it was made from. */
export interface TranslatedMeaning {
  key: string;
  meaningId: string;
  sourceHash: string;
  meaningText: string;
  definitionText: string;
  exampleTranslations: string[];
  model: string;
  /** Translations of this English text into this locale, counting reviewer-requested redos. */
  attempts?: number;
}

export interface TranslationProblem { kind: string; note: string }

/** One line of translations/<locale>.reviews.jsonl. `sourceHash` ties it to the reviewed translation. */
export interface TranslationReview {
  key: string;
  sourceHash: string;
  problems: TranslationProblem[];
  model: string;
}

/** One line of ranks.jsonl: model frequencies for every meaning of a lemma. `sourceHash` ties it to that meaning set. */
export interface RankedLemma {
  key: string;
  sourceHash: string;
  frequencies: Record<string, number>;
  model: string;
}

export interface CatalogTranslation {
  sourceHash: string;
  collection: { title: string; description: string };
  topics: Record<string, { title: string; description: string }>;
}
