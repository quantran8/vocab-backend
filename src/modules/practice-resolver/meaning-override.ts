import { ExampleView, MeaningSnapshot } from './task.types';

/** A learner's private edit. Lemma, IPA and CEFR stay shared, so grading never depends on it. */
export interface MeaningOverride {
  meaningText?: string;
  definitionText?: string;
  examples?: ExampleView[];
}

export const applyOverride = (snapshot: MeaningSnapshot, override?: MeaningOverride): MeaningSnapshot =>
  override ? { ...snapshot, ...override } : snapshot;
