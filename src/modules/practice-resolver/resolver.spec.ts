import { DELIVERY_MODE, OUTCOME, PROMPT_TYPE, TEMPLATE, TEMPLATES, VARIANT } from '../../common/constants/domain';
import { reduceMemory } from '../memory-srs/memory-reducer';
import { evaluateTask } from '../practice-evaluator/evaluate';
import { TaskEvent } from '../practice-evaluator/events';
import { CuratedItem, isContextEligible, resolveCurated } from './curated';
import { buildFlyReorder, buildMatch, buildRecording, buildSelectGloss, buildSelectReverse, buildTranscription, buildTypingRecall } from './generated';
import { DistractorView, MeaningSnapshot, ResolveContext, ResolvedTask } from './task.types';
import { findTaskProblem } from './validate-task';

const rng = () => 0.42;
const ctx: ResolveContext = { locale: 'vi-VN', accent: 'en-US', audioPlayback: true, allowPlaceholderAudio: true };
const AUDIO = 'https://cdn.example.invalid/audio/asset-8c42a1.mp3';

const snapshot = (lemma: string, meaningText: string, audioUrl: string | null = AUDIO): MeaningSnapshot => ({
  wordId: `w-${lemma}`, lemma, typeId: 't', partOfSpeech: 'verb', meaningId: `m-${lemma}`, cefrLevel: 'B1',
  meaningText, definitionText: 'def',
  pronunciations: [{ id: `p-${lemma}`, accentLocale: 'en-US', ipa: '/x/', audioUrl }],
  examples: [],
});
const clarify = snapshot('clarify', 'làm rõ');
const achieve = snapshot('achieve', 'đạt được');
const pool: DistractorView[] = [
  { wordId: 'w-achieve', lemma: 'achieve', meaningText: 'đạt được' },
  { wordId: 'w-deadline', lemma: 'deadline', meaningText: 'hạn chót' },
  { wordId: 'w-forget', lemma: 'forget', meaningText: 'quên' },
];

const expectClean = (task: ResolvedTask | null) => {
  expect(task).not.toBeNull();
  expect(JSON.stringify(task!.clientPayload)).not.toMatch(/"(wordId|meaningId|pronunciationId|typeId|targets)"/);
  return task!;
};

const curated = (template: string, variant: string, sourceContent: object, sourceEvaluation: object, extra: Partial<CuratedItem> = {}): CuratedItem => ({
  id: 'item', template, variant, contextCefrLevel: null, sourceContent, sourceEvaluation,
  localizedContent: {}, targets: [{ meaningId: 'm', pronunciationId: null }], ...extra,
});
const bothPrompts = { promptVariants: { text: { text: 'Cue' }, audio: { url: AUDIO, locale: 'vi-VN', isTargetAudio: false } } };
const options = { options: [{ id: 1, text: 'one' }, { id: 2, text: 'two' }] };
const CURATED_BY_TEMPLATE = {
  [TEMPLATE.SELECT]: curated(TEMPLATE.SELECT, VARIANT.MEANING_CLASH, { ...bothPrompts, ...options }, { correctOptionId: 1 }),
  [TEMPLATE.MATCH]: curated(TEMPLATE.MATCH, VARIANT.WORD_PAIRS, { ...bothPrompts, pairs: { left: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }], right: [{ id: 3, text: 'c' }, { id: 4, text: 'd' }] } }, { correctPairs: [{ leftId: 1, rightId: 3 }, { leftId: 2, rightId: 4 }], pairTargets: { 1: 0, 2: 1 } }),
  [TEMPLATE.CLOZE_SELECT]: curated(TEMPLATE.CLOZE_SELECT, VARIANT.SINGLE_BLANK, { ...bothPrompts, sentenceParts: { before: 'Could you ', after: ' it?' }, ...options }, { correctOptionId: 1 }),
  [TEMPLATE.TYPING]: curated(TEMPLATE.TYPING, VARIANT.MEANING_RECALL, bothPrompts, { acceptedResponses: ['clarify'] }),
  [TEMPLATE.FLY_REORDER]: curated(TEMPLATE.FLY_REORDER, VARIANT.SPELLING_RECALL, { ...bothPrompts, tiles: [{ id: 1, text: 'b' }, { id: 2, text: 'a' }] }, { acceptedResponses: ['ab'] }),
  [TEMPLATE.SURGERY]: curated(TEMPLATE.SURGERY, VARIANT.FIX_SPELLING, { ...bothPrompts, word: 'clarrify' }, { wrongGraphemeIndex: 4, replacement: '' }),
  [TEMPLATE.RECORDING]: curated(TEMPLATE.RECORDING, VARIANT.SCRIPTED_PRONUNCIATION, { ...bothPrompts, assessment: { kind: 'azurePronunciation' } }, {}),
};

describe('generated tasks', () => {
  it('C07 C42 resolves self-contained select for locale, text and audio', () => {
    const text = expectClean(buildSelectGloss(clarify, pool, PROMPT_TYPE.TEXT, ctx, rng));
    expect(text.clientPayload).toMatchObject({ prompt: { type: 'text', text: 'clarify' }, question: 'Từ này có nghĩa là gì?' });
    const audio = expectClean(buildSelectGloss(clarify, pool, PROMPT_TYPE.AUDIO, ctx, rng));
    expect(audio.clientPayload.prompt).toEqual({ type: 'audio', audio: { url: AUDIO, locale: 'en-US' } });
    expect(audio.targets[0]).toEqual({ meaningId: 'm-clarify', pronunciationId: 'p-clarify' });
    expect(audio.serverEvaluation.promptIsTargetAudio).toBe(true);
  });

  it('C08 rejects when no unambiguous distractor exists', () => {
    const collide = [{ wordId: 'w-x', lemma: 'x', meaningText: 'làm rõ' }];
    expect(buildSelectGloss(clarify, collide, PROMPT_TYPE.TEXT, ctx, rng)).toBeNull();
    expect(buildSelectGloss(clarify, [{ wordId: clarify.wordId, lemma: 'c', meaningText: 'khác' }], PROMPT_TYPE.TEXT, ctx, rng)).toBeNull();
  });

  it('never fakes audio: no capability or asset rejects the candidate', () => {
    expect(buildSelectGloss(clarify, pool, PROMPT_TYPE.AUDIO, { ...ctx, audioPlayback: false }, rng)).toBeNull();
    expect(buildSelectGloss(snapshot('clarify', 'làm rõ', null), pool, PROMPT_TYPE.AUDIO, ctx, rng)).toBeNull();
    expect(buildSelectGloss(clarify, pool, PROMPT_TYPE.AUDIO, { ...ctx, allowPlaceholderAudio: false }, rng)).toBeNull();
    expect(buildSelectGloss(snapshot('clarify', 'làm rõ', 'http://x.test/a.mp3'), pool, PROMPT_TYPE.AUDIO, ctx, rng)).toBeNull();
  });

  it('C47 rejects a blind audio URL that leaks the word', () => {
    const leaky = snapshot('clarify', 'làm rõ', 'https://cdn.test/clarify.mp3');
    expect(buildSelectGloss(leaky, pool, PROMPT_TYPE.AUDIO, ctx, rng)).toBeNull();
    expect(buildTranscription(leaky, ctx)).toBeNull();
  });

  it('typing, flyReorder, reverse, match and recording stay valid', () => {
    expectClean(buildTypingRecall(clarify, ctx));
    expectClean(buildSelectReverse(clarify, pool, ctx, rng));
    expectClean(buildTranscription(clarify, ctx));
    const fly = expectClean(buildFlyReorder(clarify, ctx, rng));
    expect(fly.clientPayload.tiles!.map((t) => t.text).join('')).not.toBe('clarify');
    expectClean(buildMatch([clarify, achieve], ctx, rng));
    const recording = expectClean(buildRecording(clarify, PROMPT_TYPE.TEXT, ctx));
    expect(recording.clientPayload).not.toHaveProperty('evaluation');
    expect(recording.serverEvaluation.referenceText).toBe('clarify');
  });

  it('flyReorder splits repeated and combining graphemes', () => {
    const fly = expectClean(buildFlyReorder(snapshot('noon', 'trưa'), ctx, rng));
    expect(fly.clientPayload.tiles!.map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(buildFlyReorder(snapshot('a', 'x'), ctx, rng)).toBeNull();
    expect(buildFlyReorder(snapshot('aa', 'x'), ctx, rng)).toBeNull();
  });
});

describe('C43 C44 all 7 templates with both prompt types', () => {
  it.each(TEMPLATES)('%s resolves text and audio', (template) => {
    const item = CURATED_BY_TEMPLATE[template];
    const text = expectClean(resolveCurated(item, PROMPT_TYPE.TEXT, ctx));
    const audio = expectClean(resolveCurated(item, PROMPT_TYPE.AUDIO, ctx));
    expect(text.clientPayload.prompt?.type).toBe(PROMPT_TYPE.TEXT);
    expect(audio.clientPayload.prompt?.type).toBe(PROMPT_TYPE.AUDIO);
    expect(resolveCurated(item, PROMPT_TYPE.AUDIO, { ...ctx, audioPlayback: false })).toBeNull();
  });

  it('never ships pairTargets to the client', () => {
    const task = expectClean(resolveCurated(CURATED_BY_TEMPLATE[TEMPLATE.MATCH], PROMPT_TYPE.TEXT, ctx));
    expect(JSON.stringify(task.clientPayload)).not.toContain('pairTargets');
    expect(task.serverEvaluation.pairTargets).toBeDefined();
  });

  it('C50 rejects English-word audio as Meaning-cued recall', () => {
    const content = { promptVariants: { audio: { url: AUDIO, locale: 'en-US', isTargetAudio: true } } };
    expect(resolveCurated(curated(TEMPLATE.TYPING, VARIANT.MEANING_RECALL, content, { acceptedResponses: ['x'] }), PROMPT_TYPE.AUDIO, ctx)).toBeNull();
  });

  it('resolved tasks evaluate end-to-end', () => {
    const task = expectClean(buildSelectGloss(clarify, pool, PROMPT_TYPE.TEXT, ctx, rng));
    const events = [{ seq: 1, action: 'submit', optionId: task.serverEvaluation.correctOptionId }] as TaskEvent[];
    const { targets } = evaluateTask({ template: task.template, body: task.clientPayload, key: task.serverEvaluation, targetOrdinals: [0], events });
    expect(targets[0].outcome).toBe('correct');
    expect(DELIVERY_MODE.NONE).toBe('none');
  });
});

describe('merged variants', () => {
  const silent = (task: ResolvedTask) =>
    reduceMemory([{ taskId: 't', ordinal: 0, meaningId: 'm', intent: task.serverEvaluation.intent, outcome: OUTCOME.CORRECT, hintCount: 0, isPrimed: false }]);
  const audioOnly = { promptVariants: { audio: { url: AUDIO, locale: 'en-US', isTargetAudio: true } } };
  const answer = (task: ResolvedTask) =>
    evaluateTask({
      template: task.template, body: task.clientPayload, key: task.serverEvaluation, targetOrdinals: [0],
      events: [{ seq: 1, action: 'submit', optionId: 1 }] as TaskEvent[],
    }).targets[0].outcome;

  it('C56 phoneticChoice shares the select evaluator but gives no semantic SRS', () => {
    const choice = expectClean(resolveCurated(curated(TEMPLATE.SELECT, VARIANT.PHONETIC_CHOICE, { ...audioOnly, ...options }, { correctOptionId: 1 }), PROMPT_TYPE.AUDIO, ctx));
    expect(answer(choice)).toBe(OUTCOME.CORRECT);
    expect(silent(choice)).toEqual([]);
    const gloss = expectClean(buildSelectGloss(clarify, pool, PROMPT_TYPE.AUDIO, ctx, rng));
    expect(silent(gloss)).toHaveLength(1);
  });

  it('C57 stressChoice validates correctOptionId with no separate evaluator or semantic SRS', () => {
    const syllables = { options: [{ id: 1, text: 'clar' }, { id: 2, text: 'i' }, { id: 3, text: 'fy' }] };
    const stress = expectClean(resolveCurated(curated(TEMPLATE.SELECT, VARIANT.STRESS_CHOICE, { ...audioOnly, ...syllables }, { correctOptionId: 1 }), PROMPT_TYPE.AUDIO, ctx));
    expect(answer(stress)).toBe(OUTCOME.CORRECT);
    expect(silent(stress)).toEqual([]);
  });

  it('C58 transcription is graded as typing but is never a Meaning-cued recall', () => {
    const task = expectClean(buildTranscription(clarify, ctx));
    expect(task.template).toBe(TEMPLATE.TYPING);
    expect(task.targets[0]).toEqual({ meaningId: null, pronunciationId: 'p-clarify' });
    expect(silent(task)).toEqual([]);
    expect(buildTranscription(clarify, { ...ctx, audioPlayback: false })).toBeNull();
  });
});

describe('validator', () => {
  const base = () => expectClean(buildTypingRecall(clarify, ctx));

  it('C55 C59 rejects retired variants and tile payloads on clozeSelect', () => {
    const task = base();
    expect(findTaskProblem({ ...task, variant: 'audioSelect' as never })).toMatch(/Variant/);
    const cloze = expectClean(resolveCurated(CURATED_BY_TEMPLATE[TEMPLATE.CLOZE_SELECT], PROMPT_TYPE.TEXT, ctx));
    const withTiles = { ...cloze, clientPayload: { ...cloze.clientPayload, tiles: [] } };
    expect(findTaskProblem(withTiles)).toMatch(/shape/);
  });

  it('a cloze without a clue is issued with no prompt, other templates are not', () => {
    const sentence = { promptVariants: {}, sentenceParts: { before: 'Could you ', after: ' it?' }, ...options };
    const cloze = expectClean(resolveCurated(curated(TEMPLATE.CLOZE_SELECT, VARIANT.SINGLE_BLANK, sentence, { correctOptionId: 1 }), PROMPT_TYPE.TEXT, ctx));
    expect(cloze.clientPayload).not.toHaveProperty('prompt');
    expect(resolveCurated(curated(TEMPLATE.CLOZE_SELECT, VARIANT.SINGLE_BLANK, sentence, { correctOptionId: 1 }), PROMPT_TYPE.AUDIO, ctx)).toBeNull();
    expect(resolveCurated(curated(TEMPLATE.SELECT, VARIANT.MEANING_CLASH, { promptVariants: {}, ...options }, { correctOptionId: 1 }), PROMPT_TYPE.TEXT, ctx)).toBeNull();
  });

  it('carries a prompt highlight to the client and rejects one outside the text', () => {
    const content = (highlight: object) => ({ promptVariants: { text: { text: 'Sign the contract.', highlight } }, ...options });
    const item = (highlight: object) => curated(TEMPLATE.SELECT, VARIANT.MEANING_CLASH, content(highlight), { correctOptionId: 1 });
    expect(expectClean(resolveCurated(item({ start: 9, end: 17 }), PROMPT_TYPE.TEXT, ctx)).clientPayload.prompt).toEqual({
      type: 'text', text: 'Sign the contract.', highlight: { start: 9, end: 17 },
    });
    expect(resolveCurated(item({ start: 9, end: 99 }), PROMPT_TYPE.TEXT, ctx)).toBeNull();
    expect(resolveCurated(item({ start: 9, end: 9 }), PROMPT_TYPE.TEXT, ctx)).toBeNull();
  });

  it('C53 rejects malformed prompts', () => {
    const task = base();
    const bad = (prompt: unknown) => findTaskProblem({ ...task, clientPayload: { ...task.clientPayload, prompt: prompt as never } });
    expect(bad('clarify')).toMatch(/shape/);
    expect(bad({ type: 'text', text: '  ' })).toMatch(/shape/);
    expect(bad({ type: 'text', text: 'a', audio: { url: AUDIO, locale: 'en' } })).toMatch(/shape/);
    expect(bad({ type: 'audio', audio: { url: 'nope', locale: 'en' } })).toMatch(/shape/);
  });

  it('C09 rejects internal ids in payload', () => {
    const task = base();
    expect(findTaskProblem({ ...task, clientPayload: { ...task.clientPayload, meaningId: 'm' } })).toMatch(/internal/);
  });
});

describe('contextual gating', () => {
  it('C36 C37 filters by editorial level and proficiency', () => {
    expect(isContextEligible('B2', 'A1', true)).toBe(false);
    expect(isContextEligible('A2', 'B1', true)).toBe(true);
    expect(isContextEligible(null, 'C2', true)).toBe(false);
    expect(isContextEligible('A1', null, true)).toBe(false);
    expect(isContextEligible(null, null, false)).toBe(true);
  });
});
