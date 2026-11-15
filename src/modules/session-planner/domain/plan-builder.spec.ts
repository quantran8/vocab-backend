import { ASSESSMENT_INTENT, PROMPT_TYPE, SESSION_MODE, SKILL, Skill, TEMPLATE } from '../../../common/constants/domain';
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

const weakPlan = (targets: MeaningSnapshot[], focus: [string, Skill[]][], overrides: Partial<PlanInput['ctx']> = {}) =>
  buildPlan({
    mode: SESSION_MODE.WEAK_WORDS_PRACTICE, newTargets: [], reviewTargets: targets, focusSkills: new Map(focus),
    pool, curated: [], proficiency: null, rng: () => 0.5,
    ctx: { locale: 'vi-VN', accent: 'en-US', audioPlayback: true, allowPlaceholderAudio: true, ...overrides },
  }).filter((s): s is PlannedTask => s.kind === 'task');

describe('Weak focuses on the skill with an issue', () => {
  const word = snapshot('clarify');
  const only = (skill: Skill) => weakPlan([word], [[word.meaningId, [skill]]]);

  it('builds one direct task per skill', () => {
    expect(only(SKILL.SPELLING).map((s) => s.task.serverEvaluation.intent)).toEqual([ASSESSMENT_INTENT.MEANING_RECALL]);
    expect(only(SKILL.LISTENING)[0].task).toMatchObject({ template: TEMPLATE.SELECT, serverEvaluation: { promptIsTargetAudio: true } });
    expect(only(SKILL.SPEAKING).map((s) => s.task.template)).toEqual([TEMPLATE.RECORDING]);
  });

  it('asks recall first so another task of the word cannot prime it', () => {
    const steps = weakPlan([word], [[word.meaningId, [SKILL.LISTENING, SKILL.SPELLING, SKILL.SPEAKING]]]);
    expect(steps).toHaveLength(3);
    expect(steps[0].task.serverEvaluation).toMatchObject({ intent: ASSESSMENT_INTENT.MEANING_RECALL, isPrimed: false });
  });

  it('falls back to a semantic task when the skill cannot be practiced', () => {
    const steps = weakPlan([word], [[word.meaningId, [SKILL.LISTENING]]], { audioPlayback: false });
    expect(steps).toHaveLength(1);
    expect(steps[0].task.clientPayload.prompt!.type).toBe(PROMPT_TYPE.TEXT);
  });

  it('gives each target its first skill before capping', () => {
    const targets = Array.from({ length: POLICY.session.practiceTaskCap }, (_, i) => snapshot(`word${i}`));
    const all = [SKILL.LISTENING, SKILL.SPELLING];
    const steps = weakPlan(targets, targets.map((t) => [t.meaningId, all]));
    expect(steps).toHaveLength(POLICY.session.practiceTaskCap);
    expect(new Set(steps.map((s) => s.task.targets[0].meaningId)).size).toBe(targets.length);
  });

  it('a target without an issue still gets a semantic task', () => {
    const other = snapshot('achieve');
    const steps = weakPlan([word, other], [[word.meaningId, [SKILL.SPEAKING]]]);
    expect(steps.map((s) => s.task.targets[0].meaningId)).toContain(other.meaningId);
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

  it('an open listening issue favours audio prompts', () => {
    let state = 7;
    const rng = () => ((state = (state * 16807) % 2147483647) / 2147483647);
    const audioShare = (gaps?: Map<string, Skill[]>) => {
      const steps = Array.from({ length: 40 }, () => daily({ skillGaps: gaps }, rng)).flat();
      return steps.filter((s) => s.task.serverEvaluation.promptIsTargetAudio).length / steps.length;
    };
    const gaps = new Map(words.map((w) => [w.meaningId, [SKILL.LISTENING]]));
    expect(audioShare(gaps)).toBeGreaterThan(audioShare());
  });
});
