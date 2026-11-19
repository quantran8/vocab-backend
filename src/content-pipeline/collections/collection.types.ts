import { CefrLevel } from '../../common/constants/domain';
import { LexiconEntry } from '../lexicon/lexicon.types';

export interface TopicSpec {
  slug: string;
  /** English source; other locales come from the translate stage. */
  title: string;
  description: string;
  iosIcon: string;
  /** Shown to the model when it assigns meanings to topics. */
  covers: string;
}

export interface CollectionSpec {
  slug: string;
  title: string;
  description: string;
  color: string;
  /** Bump to regenerate cached AI output after changing prompts or rules. */
  promptVersion: number;
  select(entry: LexiconEntry): boolean;
  /** Senses above this level are left out. */
  maxLevel: CefrLevel;
  /** Core words need more meanings; a low cap forces the model to merge senses. */
  maxMeanings(entry: LexiconEntry): number;
  examplesPerMeaning: number;
  topics: TopicSpec[];
}
