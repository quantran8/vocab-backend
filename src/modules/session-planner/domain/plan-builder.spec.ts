import { ASSESSMENT_INTENT, PROMPT_TYPE, SESSION_MODE, TASK_PHASE, TEMPLATE } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { DistractorView, MeaningSnapshot } from '../../practice-resolver/task.types';
import { buildPlan, PlannedTask, PlanInput } from './plan-builder';

const snapshot = (lemma: string): MeaningSnapshot => ({
  wordId: `w-${lemma}`, lemma, typeId: 't', partOfSpeech: 'verb', meaningId: `m-${lemma}`, cefrLevel: 'B1',
  meaningText: `nghĩa ${lemma}`, definitionText: 'def',
  pronunciations: [{ id: `p-${lemma}`, accentLocale: 'en-US', ipa: '/x/', audioUrl: 'https://cdn.example.com/a.mp3' }],
  examples: [],
});
const pool: DistractorView[] = ['one', 'two', 'three', 'four'].map((w) => ({ wordId: `w-${w}`, lemma: w, meaningText: `nghĩa ${w}` }));

const plan = (mode: PlanInput['mode'], targets: MeaningSnapshot[], overrides: Partial<PlanInput['ctx']> = {}) =>
  buildPlan({
    mode, newTargets: [], reviewTargets: targets, pool, curated: [], proficiency: null, rng: () => 0.5,
    ctx: { locale: 'vi-VN', accent: 'en-US', audioPlayback: true, allowPlaceholderAudio: true, ...overrides },
  }).filter((s): s is PlannedTask => s.kind === 'task');

describe('Speaking practice', () => {
  it('gives each target one recording with a meaning cue, in the planner\'s order', () => {
    const words = ['clarify', 'achieve', 'borrow'].map(snapshot);
    const steps = plan(SESSION_MODE.SPEAKING_PRACTICE, words);
    expect(steps.map((s) => s.task.template)).toEqual([TEMPLATE.RECORDING, TEMPLATE.RECORDING, TEMPLATE.RECORDING]);
    expect(steps.map((s) => s.task.targets[0].pronunciationId)).toEqual(words.map((w) => w.pronunciations[0].id));
    expect(steps.every((s) => s.phase === TASK_PHASE.SPEAKING_PRACTICE && s.task.clientPayload.meaningCue)).toBe(true);
  });

  it('skips a target with no pronunciation in the accent', () => {
    expect(plan(SESSION_MODE.SPEAKING_PRACTICE, [{ ...snapshot('borrow'), pronunciations: [] }])).toEqual([]);
  });
});

describe('Weak practice', () => {
  it('is mixed meaning practice, not a skill drill', () => {
    const steps = plan(SESSION_MODE.WEAK_WORDS_PRACTICE, [snapshot('clarify')], { audioPlayback: false });
    expect(steps).toHaveLength(1);
    expect(steps[0].task.clientPayload.prompt!.type).toBe(PROMPT_TYPE.TEXT);
    expect([ASSESSMENT_INTENT.MEANING_RECALL, ASSESSMENT_INTENT.MEANING_RECOGNITION]).toContain(steps[0].task.serverEvaluation.intent);
  });
});

describe('Daily review', () => {
  const words = ['clarify', 'achieve', 'borrow', 'gather', 'notice'].map(snapshot);
  const daily = (input: Partial<PlanInput> = {}, rng: () => number = () => 0.5) =>
    buildPlan({
      mode: SESSION_MODE.DAILY, newTargets: [], reviewTargets: words, pool, curated: [], proficiency: null, rng,
      ctx: { locale: 'vi-VN', accent: 'en-US', audioPlayback: true, allowPlaceholderAudio: true },
      ...input,
    }).filter((s): s is PlannedTask => s.kind === 'task');

  it('gives each due word exactly one meaning task, never a skill-only task', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      let state = seed + 1;
      const rng = () => ((state = (state * 16807) % 2147483647) / 2147483647);
      const steps = daily({}, rng);
      expect(steps.map((s) => s.task.targets[0].meaningId).sort()).toEqual(words.map((w) => w.meaningId).sort());
      for (const { task } of steps) {
        expect([ASSESSMENT_INTENT.MEANING_RECALL, ASSESSMENT_INTENT.MEANING_RECOGNITION]).toContain(task.serverEvaluation.intent);
        expect([TEMPLATE.RECORDING, TEMPLATE.MATCH]).not.toContain(task.template);
      }
    }
  });

  it('speaking on adds capped recordings, each after its word\'s meaning task', () => {
    const many = Array.from({ length: POLICY.review.dailySpeakingCap + 3 }, (_, i) => snapshot(`word${i}`));
    for (let seed = 0; seed < 20; seed += 1) {
      let state = seed + 1;
      const rng = () => ((state = (state * 16807) % 2147483647) / 2147483647);
      const steps = daily({ reviewTargets: many, speaking: true }, rng);
      const recordings = steps.filter((s) => s.task.template === TEMPLATE.RECORDING);
      expect(recordings).toHaveLength(POLICY.review.dailySpeakingCap);
      for (const { task } of recordings) expect(task.clientPayload.meaningCue).toBeDefined();
      for (const recording of recordings) {
        const pronunciationId = recording.task.targets[0].pronunciationId;
        const meaning = steps.findIndex((s) => s.task.template !== TEMPLATE.RECORDING && `p-${s.task.targets[0].meaningId!.slice(2)}` === pronunciationId);
        expect(meaning).toBeLessThan(steps.indexOf(recording));
      }
      expect(steps.filter((s) => s.task.template !== TEMPLATE.RECORDING)).toHaveLength(many.length);
    }
  });

  it('speaking off, or outside Daily, adds no recording', () => {
    expect(daily({ speaking: false }).some((s) => s.task.template === TEMPLATE.RECORDING)).toBe(false);
    const learning = buildPlan({
      mode: SESSION_MODE.DAILY, newTargets: [snapshot('borrow')], reviewTargets: [], pool, curated: [], proficiency: null, rng: () => 0.5,
      ctx: { locale: 'vi-VN', accent: 'en-US', audioPlayback: true, allowPlaceholderAudio: true },
    });
    expect(learning.some((s) => s.kind === 'task' && s.task.template === TEMPLATE.RECORDING)).toBe(false);
  });

  it('a new word\'s recording is read from the word, with no meaning cue', () => {
    const steps = buildPlan({
      mode: SESSION_MODE.DAILY, newTargets: [snapshot('borrow')], reviewTargets: [], pool, curated: [], proficiency: null, rng: () => 0.5, speaking: true,
      ctx: { locale: 'vi-VN', accent: 'en-US', audioPlayback: true, allowPlaceholderAudio: true },
    }).filter((s): s is PlannedTask => s.kind === 'task' && s.task.template === TEMPLATE.RECORDING);
    expect(steps).toHaveLength(1);
    expect(steps[0].task.clientPayload.meaningCue).toBeUndefined();
  });

  it('a new word without a pronunciation is still learnable', () => {
    const silent = { ...snapshot('borrow'), pronunciations: [] };
    const steps = buildPlan({
      mode: SESSION_MODE.DAILY, newTargets: [silent], reviewTargets: [], pool, curated: [], proficiency: null, rng: () => 0.5, speaking: true,
      ctx: { locale: 'vi-VN', accent: 'en-US', audioPlayback: true, allowPlaceholderAudio: true },
    });
    expect(steps.filter((s) => s.kind === 'learn')).toHaveLength(1);
    expect(steps.some((s) => s.kind === 'task' && s.task.template === TEMPLATE.RECORDING)).toBe(false);
  });
});
