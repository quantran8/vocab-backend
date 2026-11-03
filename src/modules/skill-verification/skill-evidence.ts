import {
  ASSESSMENT_INTENT, AssessmentIntent, DELIVERY_MODE, DeliveryMode, EVIDENCE_REASON, EvidenceReason, OUTCOME, Outcome,
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
  reasons: EvidenceReason[];
  validity: Validity;
  passed: boolean | null;
  meaningId: string | null;
  pronunciationId: string | null;
}

const when = (condition: boolean, reason: EvidenceReason) => (condition ? [reason] : []);

const assistance = (fact: SkillFact) => [
  ...when(fact.hintCount > 0, EVIDENCE_REASON.HINTED),
  ...when(fact.outcome === OUTCOME.REVEALED, EVIDENCE_REASON.REVEALED),
  ...when(fact.isPrimed, EVIDENCE_REASON.PRIMED),
];

const meaningEvidence = (fact: SkillFact, skill: Skill, weakTemplate: boolean): EvidenceDraft[] =>
  fact.meaningId
    ? [{
        skill,
        reasons: [
          ...when(weakTemplate, EVIDENCE_REASON.WEAK_TEMPLATE),
          ...when(!fact.qualityQualified, EVIDENCE_REASON.QUALITY_UNQUALIFIED),
          ...assistance(fact),
        ],
        validity: VALIDITY.VALID,
        passed: fact.outcome === OUTCOME.CORRECT,
        meaningId: fact.meaningId,
        pronunciationId: null,
      }]
    : [];

function listeningEvidence(fact: SkillFact, weakTemplate: boolean): EvidenceDraft[] {
  if (!fact.pronunciationId) return [];
  // Audio that never played says nothing about listening: invalid, not failed.
  const delivered = fact.deliveryMode === DELIVERY_MODE.AUDIO;
  return [{
    skill: SKILL.LISTENING,
    reasons: [
      ...when(!delivered, EVIDENCE_REASON.AUDIO_NOT_PLAYED),
      ...when(weakTemplate, EVIDENCE_REASON.WEAK_TEMPLATE),
      ...assistance(fact),
    ],
    validity: delivered ? VALIDITY.VALID : VALIDITY.INVALID,
    passed: delivered ? fact.outcome === OUTCOME.CORRECT : null,
    meaningId: null,
    pronunciationId: fact.pronunciationId,
  }];
}

function speakingEvidence(fact: SkillFact): EvidenceDraft[] {
  if (!fact.pronunciationId || fact.outcome === OUTCOME.UNAVAILABLE) return [];
  const valid = fact.outcome !== OUTCOME.INVALID;
  return [{
    skill: SKILL.SPEAKING,
    reasons: when(!valid, EVIDENCE_REASON.INVALID_RECORDING),
    validity: valid ? VALIDITY.VALID : VALIDITY.INVALID,
    passed: valid ? fact.outcome === OUTCOME.ASSESSED_PASSED : null,
    meaningId: null,
    pronunciationId: fact.pronunciationId,
  }];
}

/** Evidence depends on stimulus + response + target + delivery, never on prompt type alone (AR-15). */
export function deriveEvidence(fact: SkillFact): EvidenceDraft[] {
  // Right after Learn the answer was just taught — see memory skill-evidence-learning.
  const phase = when(fact.phase === TASK_PHASE.NEW_PRACTICE, EVIDENCE_REASON.NEW_PRACTICE);
  return evidenceFor(fact).map((d) => ({ ...d, reasons: [...phase, ...d.reasons] }));
}

function evidenceFor(fact: SkillFact): EvidenceDraft[] {
  switch (fact.intent) {
    case ASSESSMENT_INTENT.MEANING_RECOGNITION:
      if (fact.promptIsTargetAudio) return listeningEvidence(fact, false);
      return meaningEvidence(fact, SKILL.READING, fact.template !== TEMPLATE.SELECT);
    case ASSESSMENT_INTENT.MEANING_RECALL:
      return meaningEvidence(fact, SKILL.WRITING, false);
    case ASSESSMENT_INTENT.TRANSCRIPTION:
      return fact.promptIsTargetAudio ? listeningEvidence(fact, false) : [];
    case ASSESSMENT_INTENT.SOUND_DISCRIMINATION:
      return listeningEvidence(fact, true);
    case ASSESSMENT_INTENT.PRONUNCIATION:
      return speakingEvidence(fact);
    case ASSESSMENT_INTENT.PAIRING:
      return meaningEvidence(fact, SKILL.READING, true);
    case ASSESSMENT_INTENT.SPELLING_REPAIR:
      return meaningEvidence(fact, SKILL.WRITING, true);
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
    return { status: hadPass ? SKILL_STATUS.DEMONSTRATED : SKILL_STATUS.NOT_VERIFIED, needsPractice };
  }
  const sessions = new Set(passes.map((r) => r.sessionId));
  const spanHours = (passes.at(-1)!.committedAt.getTime() - passes[0].committedAt.getTime()) / MS_PER_HOUR;
  const verified = sessions.size >= POLICY.skill.requiredSessions && spanHours >= POLICY.skill.delayedRecheckHours;
  return { status: verified ? SKILL_STATUS.VERIFIED : SKILL_STATUS.DEMONSTRATED, needsPractice };
}

export interface WordScopes {
  readingWriting: SkillStatus[];
  listeningSpeaking: SkillStatus[];
  learnedMeaningCount: number;
}

export const isWordFullyVerified = ({ readingWriting, listeningSpeaking, learnedMeaningCount }: WordScopes) =>
  learnedMeaningCount > 0 &&
  [...readingWriting, ...listeningSpeaking].every((s) => s === SKILL_STATUS.VERIFIED);
