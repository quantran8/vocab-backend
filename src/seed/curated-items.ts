import { VARIANT } from '../common/constants/domain';

/** Authoring shape of seed/data/curated-items.json (vocabflow.curated.authoring.v1). */
export interface AuthoredItem {
  id: string;
  template: string;
  variant: string;
  contextCefrLevel: string;
  status: string;
  sourceContent: { promptVariants: { text?: { kind: string; text?: string; focusWord?: string } }; body: Record<string, unknown> };
  sourceEvaluation: Record<string, unknown>;
  localizedContent: Record<string, unknown>;
  contextualExplain: string;
  targets: { ordinal: number; meaningId: string | null; pronunciationId: string | null; lemmaForQA: string }[];
}

export interface PromptLookup {
  ipaByPronunciation: Map<string, string>;
  meaningTextByMeaning: Map<string, string>;
}

// The resolver needs a literal text prompt and a flat body; the authoring kinds only say where that text comes from.
function promptText(item: AuthoredItem, lookup: PromptLookup) {
  const { kind, text } = item.sourceContent.promptVariants.text!;
  const [target] = item.targets;
  switch (kind) {
    case 'authoredContext': return text!;
    case 'publishedIPA': return lookup.ipaByPronunciation.get(target.pronunciationId!)!;
    case 'publishedWordText': return target.lemmaForQA;
    case 'publishedMeaningCue': return lookup.meaningTextByMeaning.get(target.meaningId!)!;
    default: throw new Error(`Unknown prompt kind ${kind} on ${item.id}`);
  }
}

// Offsets go to the client so it never has to search the sentence for the word.
function highlightOf(text: string, focusWord: string, id: string) {
  const start = text.search(new RegExp(`\\b${focusWord}\\b`, 'i'));
  if (start < 0) throw new Error(`Focus word not in prompt on ${id}`);
  return { start, end: start + focusWord.length };
}

export function toRuntimeContent(item: AuthoredItem, lookup: PromptLookup) {
  // A cloze with no clue has no prompt at all: its sentence is the stimulus.
  const text = item.sourceContent.promptVariants.text ? promptText(item, lookup) : null;
  if (item.sourceContent.promptVariants.text && !text) throw new Error(`No prompt text for ${item.id}`);
  const { optionIds: _optionIds, syllables, ...body } = item.sourceContent.body;
  // Stress options are the syllables themselves; "Syllable 1" labels would tell the learner nothing.
  const options = item.variant === VARIANT.STRESS_CHOICE
    ? { options: (syllables as string[]).map((label, index) => ({ id: index + 1, text: label })) }
    : {};
  const focusWord = item.sourceContent.promptVariants.text?.focusWord;
  const highlight = text && focusWord ? { highlight: highlightOf(text, focusWord, item.id) } : {};
  return { promptVariants: text ? { text: { text, ...highlight } } : {}, ...body, ...options };
}
