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
    expect(only(SKILL.READING).map((s) => s.task)).toEqual([expect.objectContaining({ template: TEMPLATE.SELECT })]);
    expect(only(SKILL.READING)[0].task.serverEvaluation.promptIsTargetAudio).toBe(false);
    expect(only(SKILL.WRITING).map((s) => s.task.serverEvaluation.intent)).toEqual([ASSESSMENT_INTENT.MEANING_RECALL]);
    expect(only(SKILL.LISTENING)[0].task).toMatchObject({ template: TEMPLATE.SELECT, serverEvaluation: { promptIsTargetAudio: true } });
    expect(only(SKILL.SPEAKING).map((s) => s.task.template)).toEqual([TEMPLATE.RECORDING]);
  });

  it('asks recall first so another task of the word cannot prime it', () => {
    const steps = weakPlan([word], [[word.meaningId, [SKILL.READING, SKILL.WRITING, SKILL.SPEAKING]]]);
    expect(steps).toHaveLength(3);
    expect(steps[0].task.serverEvaluation).toMatchObject({ intent: ASSESSMENT_INTENT.MEANING_RECALL, isPrimed: false });
  });

  it('falls back to a semantic task when the skill cannot be practiced', () => {
    const steps = weakPlan([word], [[word.meaningId, [SKILL.LISTENING]]], { audioPlayback: false });
    expect(steps).toHaveLength(1);
    expect(steps[0].task.clientPayload.prompt.type).toBe(PROMPT_TYPE.TEXT);
  });

  it('gives each target its first skill before capping', () => {
    const targets = Array.from({ length: POLICY.session.practiceTaskCap }, (_, i) => snapshot(`word${i}`));
    const all = [SKILL.READING, SKILL.WRITING];
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
