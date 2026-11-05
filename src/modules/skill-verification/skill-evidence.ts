import {
  ASSESSMENT_INTENT, AssessmentIntent, DELIVERY_MODE, DeliveryMode, EVIDENCE_REASON, EvidenceReason, OUTCOME, Outcome,
  SKILL, Skill, SKILL_ISSUE, SKILL_STATUS, SkillIssue, SkillStatus, TASK_PHASE, TaskPhase, TEMPLATE, Template, VALIDITY, Validity,
} from '../../common/constants/domain';
import { MS_PER_HOUR } from '../../common/constants/time';
import { POLICY } from '../../config/policy';
import { isLightRetry } from '../memory-srs/memory-reducer';

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
  attemptCount: number;
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
  ...when(fact.intent === ASSESSMENT_INTENT.MEANING_RECALL && isLightRetry(fact), EVIDENCE_REASON.RETRIED),
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

/** The skill a task of this shape trains; must agree with evidenceFor below. */
export function skillOf(intent: AssessmentIntent, promptIsTargetAudio: boolean): Skill | null {
  switch (intent) {
    case ASSESSMENT_INTENT.MEANING_RECOGNITION:
      return promptIsTargetAudio ? SKILL.LISTENING : SKILL.READING;
    case ASSESSMENT_INTENT.TRANSCRIPTION:
      return promptIsTargetAudio ? SKILL.LISTENING : null;
    case ASSESSMENT_INTENT.SOUND_DISCRIMINATION:
      return SKILL.LISTENING;
    case ASSESSMENT_INTENT.PRONUNCIATION:
      return SKILL.SPEAKING;
    case ASSESSMENT_INTENT.PAIRING:
      return SKILL.READING;
    case ASSESSMENT_INTENT.MEANING_RECALL:
    case ASSESSMENT_INTENT.SPELLING_REPAIR:
      return SKILL.WRITING;
  }
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
  reasons: EvidenceReason[];
}

export interface SkillState {
  status: SkillStatus;
  needsPractice: boolean;
  issue: SkillIssue | null;
}

// Other reasons (new learning, weak template, ...) say nothing about this skill.
export const SKILL_STATE_REASONS: EvidenceReason[] = [
  EVIDENCE_REASON.HINTED, EVIDENCE_REASON.REVEALED, EVIDENCE_REASON.RETRIED, EVIDENCE_REASON.PRIMED,
];

const PASS = 'pass';

function classify({ passed, reasons }: EvidenceRow): typeof PASS | SkillIssue | null {
  if (!reasons.every((r) => SKILL_STATE_REASONS.includes(r))) return null;
  if (passed) {
    if (reasons.length === 0) return PASS;
    return reasons.includes(EVIDENCE_REASON.HINTED) ? SKILL_ISSUE.ASSISTED : null;
  }
  return reasons.includes(EVIDENCE_REASON.RETRIED) ? SKILL_ISSUE.ASSISTED : SKILL_ISSUE.FAILED;
}

const isIssue = (kind: ReturnType<typeof classify>) => kind === SKILL_ISSUE.FAILED || kind === SKILL_ISSUE.ASSISTED;

function currentIssue(rows: EvidenceRow[]): SkillIssue | null {
  const last = rows.findLastIndex((r) => isIssue(classify(r)));
  if (last < 0) return null;
  const earliestRecovery = rows[last].committedAt.getTime() + POLICY.memory.recoveryHours * MS_PER_HOUR;
  const recovered = rows.slice(last + 1).some((r) => classify(r) === PASS && r.committedAt.getTime() >= earliestRecovery);
  if (recovered) return null;
  const failedInSession = rows.some((r) => r.sessionId === rows[last].sessionId && classify(r) === SKILL_ISSUE.FAILED);
  return failedInSession ? SKILL_ISSUE.FAILED : SKILL_ISSUE.ASSISTED;
}

/** Input: valid rows carrying only SKILL_STATE_REASONS for one skill + scope, oldest first. Rules: memory memory-assessment-rework. */
export function deriveSkillStatus(allRows: EvidenceRow[]): SkillState {
  const issue = currentIssue(allRows);
  const needsPractice = issue !== null;
  const rows = allRows.filter((r) => [PASS, SKILL_ISSUE.FAILED].includes(classify(r) as string));
  const lastFailure = rows.findLastIndex((r) => classify(r) === SKILL_ISSUE.FAILED);
  const passes = rows.slice(lastFailure + 1);

  if (passes.length === 0) {
    const hadPass = rows.some((r) => classify(r) === PASS);
    return { status: hadPass ? SKILL_STATUS.DEMONSTRATED : SKILL_STATUS.NOT_VERIFIED, needsPractice, issue };
  }
  const sessions = new Set(passes.map((r) => r.sessionId));
  const spanHours = (passes.at(-1)!.committedAt.getTime() - passes[0].committedAt.getTime()) / MS_PER_HOUR;
  const verified = sessions.size >= POLICY.skill.requiredSessions && spanHours >= POLICY.skill.delayedRecheckHours;
  return { status: verified ? SKILL_STATUS.VERIFIED : SKILL_STATUS.DEMONSTRATED, needsPractice, issue };
}

export interface WordScopes {
  readingWriting: SkillStatus[];
  listeningSpeaking: SkillStatus[];
  learnedMeaningCount: number;
}

export const isWordFullyVerified = ({ readingWriting, listeningSpeaking, learnedMeaningCount }: WordScopes) =>
  learnedMeaningCount > 0 &&
  [...readingWriting, ...listeningSpeaking].every((s) => s === SKILL_STATUS.VERIFIED);
