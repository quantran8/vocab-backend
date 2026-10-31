import {
  ASSESSMENT_INTENT, AssessmentIntent, DELIVERY_MODE, DeliveryMode, DIRECTNESS, Directness, OUTCOME, Outcome,
  SKILL, Skill, SKILL_STATUS, SkillStatus, TASK_PHASE, TaskPhase, TEMPLATE, Template, VALIDITY, Validity,
} from '../../common/constants/domain';
import { MS_PER_HOUR } from '../../common/constants/time';
import { POLICY } from '../../config/policy';

export interface SkillFact {
  template: Template;
  intent: AssessmentIntent;
  phase: TaskPhase;
  promptIsTargetAudio: boolean;
  qualityQualified: boolean;
  isPrimed: boolean;
  deliveryMode: DeliveryMode;
  outcome: Outcome;
  hintCount: number;
  meaningId: string | null;
  pronunciationId: string | null;
}

export interface EvidenceDraft {
  skill: Skill;
  directness: Directness;
  validity: Validity;
  passed: boolean | null;
  meaningId: string | null;
  pronunciationId: string | null;
}

const isCleanAttempt = (fact: SkillFact) =>
  fact.hintCount === 0 && fact.outcome !== OUTCOME.revealed && !fact.isPrimed && fact.phase !== TASK_PHASE.newPractice;

const meaningEvidence = (fact: SkillFact, skill: Skill, direct: boolean): EvidenceDraft[] =>
  fact.meaningId
    ? [{
        skill,
        directness: direct ? DIRECTNESS.direct : DIRECTNESS.supporting,
        validity: VALIDITY.valid,
        passed: fact.outcome === OUTCOME.correct,
        meaningId: fact.meaningId,
        pronunciationId: null,
      }]
    : [];

function listeningEvidence(fact: SkillFact, direct: boolean): EvidenceDraft[] {
  if (!fact.pronunciationId) return [];
  // Audio that never played says nothing about listening: invalid, not failed.
  const delivered = fact.deliveryMode === DELIVERY_MODE.audio;
  return [{
    skill: SKILL.listening,
    directness: direct && delivered ? DIRECTNESS.direct : DIRECTNESS.supporting,
    validity: delivered ? VALIDITY.valid : VALIDITY.invalid,
    passed: delivered ? fact.outcome === OUTCOME.correct : null,
    meaningId: null,
    pronunciationId: fact.pronunciationId,
  }];
}

function speakingEvidence(fact: SkillFact): EvidenceDraft[] {
  if (!fact.pronunciationId || fact.outcome === OUTCOME.unavailable) return [];
  const valid = fact.outcome !== OUTCOME.invalid;
  return [{
    skill: SKILL.speaking,
    directness: valid && fact.phase !== TASK_PHASE.newPractice ? DIRECTNESS.direct : DIRECTNESS.supporting,
    validity: valid ? VALIDITY.valid : VALIDITY.invalid,
    passed: valid ? fact.outcome === OUTCOME.assessedPassed : null,
    meaningId: null,
    pronunciationId: fact.pronunciationId,
  }];
}

/** Evidence depends on stimulus + response + target + delivery, never on prompt type alone (AR-15). */
export function deriveEvidence(fact: SkillFact): EvidenceDraft[] {
  const clean = isCleanAttempt(fact);
  switch (fact.intent) {
    case ASSESSMENT_INTENT.meaningRecognition: {
      if (fact.promptIsTargetAudio) return listeningEvidence(fact, clean);
      const isPlainSelect = fact.template === TEMPLATE.select && fact.qualityQualified;
      return meaningEvidence(fact, SKILL.reading, clean && isPlainSelect);
    }
    case ASSESSMENT_INTENT.meaningRecall:
      return meaningEvidence(fact, SKILL.writing, clean && fact.qualityQualified);
    case ASSESSMENT_INTENT.transcription:
      return fact.promptIsTargetAudio ? listeningEvidence(fact, clean) : [];
    case ASSESSMENT_INTENT.soundDiscrimination:
      return listeningEvidence(fact, false);
    case ASSESSMENT_INTENT.pronunciation:
      return speakingEvidence(fact);
    case ASSESSMENT_INTENT.pairing:
      return meaningEvidence(fact, SKILL.reading, false);
    case ASSESSMENT_INTENT.spellingRepair:
      return meaningEvidence(fact, SKILL.writing, false);
  }
}

export interface EvidenceRow {
  sessionId: string;
  passed: boolean | null;
  committedAt: Date;
}

export interface SkillState {
  status: SkillStatus;
  needsPractice: boolean;
}

/** Input: valid direct rows for one skill + scope, oldest first. */
export function deriveSkillStatus(rows: EvidenceRow[]): SkillState {
  const lastFailure = rows.findLastIndex((r) => r.passed === false);
  const passes = rows.slice(lastFailure + 1).filter((r) => r.passed === true);
  const needsPractice = lastFailure === rows.length - 1 && rows.length > 0;

  if (passes.length === 0) {
    const hadPass = rows.some((r) => r.passed === true);
    return { status: hadPass ? SKILL_STATUS.demonstrated : SKILL_STATUS.notVerified, needsPractice };
  }
  const sessions = new Set(passes.map((r) => r.sessionId));
  const spanHours = (passes.at(-1)!.committedAt.getTime() - passes[0].committedAt.getTime()) / MS_PER_HOUR;
  const verified = sessions.size >= POLICY.skill.requiredSessions && spanHours >= POLICY.skill.delayedRecheckHours;
  return { status: verified ? SKILL_STATUS.verified : SKILL_STATUS.demonstrated, needsPractice };
}

export interface WordScopes {
  readingWriting: SkillStatus[];
  listeningSpeaking: SkillStatus[];
  learnedMeaningCount: number;
}

export const isWordFullyVerified = ({ readingWriting, listeningSpeaking, learnedMeaningCount }: WordScopes) =>
  learnedMeaningCount > 0 &&
  [...readingWriting, ...listeningSpeaking].every((s) => s === SKILL_STATUS.verified);
