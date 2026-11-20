import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { MEMORY_SIGNAL, SESSION_MODE, SESSION_STATUS, SessionMode } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { Tx } from '../../../db/db';
import { reviewResult } from '../../journey/domain/journey';
import { MemoryDraft } from '../../memory-srs/memory-reducer';
import { applyReview, initialState, knownState, ReviewOutcome, SrsState } from '../../memory-srs/fsrs';
import { CommitBody } from '../../practice-evaluator/events';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { lpAwards } from '../../learning-points/domain/lp-awards';
import { nextTier, tierKey, unlockedBetween } from '../../learning-points/domain/tier';
import { EffortRepository, EffortResult } from '../../learning-points/repositories/effort.repository';
import { canonicalHash } from '../domain/canonical';
import { CommitRepository, ProgressRow, SpeakingRow } from '../repositories/commit.repository';
import { countedAsReview, Labels, newWordSummary, planOrder, practiceSummary, reviewSummary, SpeakingOutcome, speakingSummary } from '../domain/result-summary';
import { applySpeaking } from '../../speaking/speaking-progress';
import { countedTasks, evaluateBatch, EvaluatedTask, LearnStepRow, memoryDrafts, sessionResult, speakingResults, TargetRow } from '../domain/commit-evaluator';

// A word marked known with no check has no recall to judge; only a miss in a shared task undoes it.
const SLIP_SIGNALS: string[] = [MEMORY_SIGNAL.FAILED_RECALL, MEMORY_SIGNAL.FAILED_RECOGNITION, MEMORY_SIGNAL.ASSISTED_RECALL];

/** Modes whose results screen shows practice groups and the need-practice count. */
const PRACTICE_MODES: SessionMode[] = [SESSION_MODE.RANDOM_PRACTICE, SESSION_MODE.WEAK_WORDS_PRACTICE];

@Injectable()
export class CommitService {
  constructor(
    private readonly repository: CommitRepository,
    private readonly effort: EffortRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  commit(userId: string, sessionId: string, body: CommitBody) {
    const requestHash = canonicalHash(body);
    return this.repository.transaction((tx) => this.run(tx, userId, sessionId, body, requestHash));
  }

  async status(userId: string, sessionId: string) {
    const session = await this.repository.findStatus(sessionId);
    if (!session) throw new ApiError('NOT_FOUND', 'Session not found');
    if (session.userId !== userId) throw new ApiError('SESSION_NOT_OWNED');
    return {
      sessionId,
      status: session.status,
      committedAt: session.committedAt,
      expiresAt: session.expiresAt,
      response: session.commitResponse,
    };
  }

  // Round trips are the commit's cost: lock, one read, the LP write, one write, the backlog settle (plus the challenge update for a legacy checkpoint session).
  private async run(tx: Tx, userId: string, sessionId: string, body: CommitBody, requestHash: string) {
    await this.repository.lockUser(tx, userId);
    const now = this.clock.now();
    const session = await this.repository.loadSession(tx, userId, sessionId, now);

    if (!session) throw new ApiError('NOT_FOUND', 'Session not found');
    if (session.userId !== userId) throw new ApiError('SESSION_NOT_OWNED');
    if (session.status === SESSION_STATUS.COMMITTED) {
      if (session.commitRequestSha256 === requestHash) return session.commitResponse;
      throw new ApiError('SESSION_PAYLOAD_CONFLICT');
    }
    if (session.status === SESSION_STATUS.EXPIRED || session.expiresAt <= now) throw new ApiError('SESSION_EXPIRED');

    const { tasks, targets, steps } = session;
    const receiptMap = new Map(session.receipts.map((r) => [r.id, r]));
    const { evaluated, known, declared } = evaluateBatch(body, tasks, targets, steps, receiptMap);
    const counted = countedTasks(evaluated, targets, known);
    const memory = memoryDrafts(counted, targets);

    const newMeaningIds = steps.map((s) => s.meaningId);
    const progress = session.progress;

    // First commit wins; a stale concurrent plan is rejected whole, never merged (C14).
    if (newMeaningIds.some((id) => progress.has(id))) throw new ApiError('SESSION_STALE', 'A Meaning was already learned');

    if (session.mode === SESSION_MODE.CHECKPOINT_CHALLENGE) {
      await this.completeChallenge(tx, { id: sessionId, userId, scopeSnapshot: session.scopeSnapshot });
    }

    // LP is judged on the SRS state before this commit (spec §2.1), so it runs ahead of applySrs's write.
    const awards = lpAwards({ mode: session.mode, now, issuedAt: session.issuedAt, evaluated, targets, newMeaningIds, known, progress, ...session.lp });
    const effort = await this.effort.record(tx, { userId, sessionId, awards, now });

    const newStates = this.applySrs(memory, newMeaningIds, known, declared, progress, now);
    const learnedHere = new Set(newMeaningIds);
    const speaking = this.speakingProgress(speakingResults(counted, targets, session.receipts), session.speaking, now);
    const results = this.resultSummary({
      mode: session.mode, now, tasks, targets, steps, counted, memory, known, progress, newStates, learnedHere,
      labels: new Labels(session.labels), speaking: speaking.outcomes,
    });
    const summary = {
      newWordGoalSlots: steps.length,
      knownMeanings: known.size,
      reviewedMeanings: session.mode === SESSION_MODE.DAILY ? memory.filter((m) => !learnedHere.has(m.meaningId)).length : 0,
      practiceTasks: tasks.length,
      ...results.summary,
      // No pass mark: the counts only show what came back unaided; SRS already took every answer.
      ...(session.mode === SESSION_MODE.CHECKPOINT_CHALLENGE && {
        checkpoint: reviewResult(memory.length, memory.filter((m) => m.signal === MEMORY_SIGNAL.UNAIDED_RECALL).length),
      }),
    };
    const response = { sessionId, status: SESSION_STATUS.COMMITTED, committedAt: now.toISOString(), summary, ...this.effortResponse(effort, now) };
    const viaTopics = new Map(steps.map((s) => [s.meaningId, s.viaTopicId ?? null]));
    const withScopeEvents = session.mode === SESSION_MODE.DAILY && steps.length > 0;
    const withNeedPractice = PRACTICE_MODES.includes(session.mode);

    const stored = await this.write(tx, {
      userId, sessionId, now, requestHash, response, evaluated, speaking: speaking.rows, memory, newStates, newMeaningIds, viaTopics, targets, receiptMap,
      withScopeEvents, withNeedPractice, stats: results.stats,
    });
    const settled = withNeedPractice ? await this.repository.settleNeedPractice(tx, sessionId, userId, now) : stored;
    await this.repository.settleBacklog(tx, userId, now);
    return settled;
  }

  private speakingProgress(results: ReturnType<typeof speakingResults>, before: Map<string, SpeakingRow>, now: Date) {
    const outcomes: SpeakingOutcome[] = [];
    const rows: SpeakingRow[] = [];
    for (const result of results) {
      const { next, change } = applySpeaking(before.get(result.pronunciationId) ?? null, result, now);
      outcomes.push({ result, status: next.status, change });
      rows.push({ ...next, pronunciationId: result.pronunciationId });
    }
    return { outcomes, rows };
  }

  /** The results screen's groups (spec: Session Result Statistics). Every block is null outside its modes. */
  private resultSummary(input: {
    mode: SessionMode; now: Date;
    tasks: { id: string; ordinal: number }[]; targets: TargetRow[]; steps: LearnStepRow[];
    counted: EvaluatedTask[]; memory: MemoryDraft[]; known: Set<string>;
    progress: Map<string, ProgressRow>; newStates: Map<string, SrsState>; learnedHere: Set<string>;
    labels: Labels; speaking: SpeakingOutcome[];
  }) {
    const { mode, now, tasks, targets, steps, counted, memory, known, progress, newStates, learnedHere, labels } = input;
    const order = planOrder(tasks, targets, steps);
    const sessionMeanings = new Set(targets.flatMap((t) => t.meaningId ?? []));
    const speaking = speakingSummary({ outcomes: input.speaking, labels, sessionMeanings });
    const speakingStats = speaking && { speakingTotal: speaking.total, speakingPassed: speaking.passed };
    // skillChanges stays null for one release so older clients still find the key.
    const none = { review: null, newWords: null, practice: null, speaking, skillChanges: null, needPractice: null, countedAsReview: null };

    if (mode === SESSION_MODE.DAILY) {
      const review = reviewSummary({ memory, progress, learnedHere, newStates, counted, targets, labels, order });
      const newWords = newWordSummary({ steps, counted, targets, known, newStates, labels });
      return {
        summary: { ...none, review, newWords },
        stats: {
          reviewTotal: review.total, reviewSolid: review.groups.solid.length, newTotal: newWords.total, newSmooth: newWords.groups.smooth.length,
          ...speakingStats,
        },
      };
    }
    if (!PRACTICE_MODES.includes(mode)) return { summary: none, stats: speakingStats || null };

    const practice = practiceSummary({ counted, targets, labels, sessionMeanings });
    return {
      summary: {
        ...none,
        practice,
        needPractice: { before: null, after: null },
        countedAsReview: countedAsReview({ memory, progress, newStates, now, labels, order }),
      },
      stats: { practiceTotal: practice.total, practiceClean: practice.groups.clean.length, needPracticeAfter: null, ...speakingStats },
    };
  }

  private effortResponse(effort: EffortResult, now: Date) {
    const next = nextTier(effort.level);
    return {
      lp: { earned: effort.earned, breakdown: effort.breakdown, lpPolicyVersion: POLICY.lp.version, weeklyLP: effort.weeklyLP, lifetimeLP: effort.lifetimeLP },
      tier: {
        level: effort.level,
        key: tierKey(effort.level),
        lifetimeActiveDays: effort.lifetimeActiveDays,
        tierUps: unlockedBetween(effort.oldLevel, effort.level).map((l) => ({ level: l.level, key: l.key, unlockedAt: now.toISOString() })),
        nextTier: next,
      },
      ranking: { weeklyLP: effort.weeklyLP, listed: this.config.rankingEnabled && effort.canList && effort.weeklyLP > 0 },
    };
  }

  private async completeChallenge(tx: Tx, session: { id: string; userId: string; scopeSnapshot: { challengeId?: string } }) {
    const { challengeId } = session.scopeSnapshot;
    if (!challengeId) throw new ApiError('TASK_DATA_INVALID', 'Checkpoint session has no challenge');
    if (!(await this.repository.completeChallenge(tx, challengeId, session.userId, session.id))) throw new ApiError('SESSION_STALE', 'Challenge already completed');
  }

  private applySrs(memory: MemoryDraft[], newMeaningIds: string[], known: Set<string>, declared: Set<string>, progress: Map<string, ProgressRow>, now: Date) {
    const observations = new Map(memory.map((m) => [m.meaningId, m]));
    const outcome = (m: MemoryDraft | undefined): ReviewOutcome | undefined => (m?.grade ? { grade: m.grade, weight: m.weight } : undefined);
    const states = new Map<string, SrsState>();
    for (const id of newMeaningIds) {
      // A later slip in the same session (a shared task) falls back to the normal first schedule.
      const observation = observations.get(id);
      const stillKnown = declared.has(id)
        ? !observation || SLIP_SIGNALS.every((signal) => signal !== observation.signal)
        : known.has(id) && observation?.signal === MEMORY_SIGNAL.UNAIDED_RECALL && !observation.isPrimed;
      states.set(id, stillKnown ? knownState(now) : initialState(outcome(observation), now));
    }
    for (const observation of memory) {
      const current = progress.get(observation.meaningId);
      const review = outcome(observation);
      // No usable evidence leaves the state, last review included, as it was.
      if (current && review) states.set(observation.meaningId, applyReview(current, review, now));
    }
    return states;
  }

  private async write(tx: Tx, input: {
    userId: string; sessionId: string; now: Date; requestHash: string; response: object;
    evaluated: EvaluatedTask[]; speaking: SpeakingRow[]; memory: MemoryDraft[]; newStates: Map<string, SrsState>; newMeaningIds: string[];
    viaTopics: Map<string, string | null>; withScopeEvents: boolean; withNeedPractice: boolean; stats: object | null;
    targets: TargetRow[]; receiptMap: Map<string, { assessedAt: Date; accuracyScore: number | null }>;
  }) {
    const { userId, sessionId, now, requestHash, response, evaluated, speaking, memory, newStates, newMeaningIds, viaTopics, withScopeEvents, withNeedPractice, targets, receiptMap, stats } = input;
    const learnedHere = new Set(newMeaningIds);
    const data = JSON.stringify({
      rawEvents: evaluated.map((e) => ({ taskId: e.task.id, events: e.rawEvents })),
      // `summary` keeps the headline counts after raw_events are purged, so sessions can be compared later.
      result: { ...sessionResult(evaluated, targets, receiptMap), ...(stats && { summary: stats }) },
      speaking: speaking.map((r) => ({
        pronunciation_id: r.pronunciationId, status: r.status, device_sessions: r.deviceSessions, device_streak: r.deviceStreak,
        scored_sessions: r.scoredSessions, score_avg: r.scoreAvg, last_score: r.lastScore, best_score: r.bestScore,
        last_passed: r.lastPassed, last_assessed_at: r.lastAssessedAt, fluent_at: r.fluentAt,
      })),
      memory: memory.map((m) => ({
        meaning_id: m.meaningId, signal: m.signal, is_primed: m.isPrimed, source_task_ids: m.sourceTaskIds, grade: m.grade, evidence_weight: m.weight,
      })),
      progress: [...newStates].map(([meaningId, state]) => ({
        meaning_id: meaningId,
        learned_at: state.learnedAt,
        learned_session_id: learnedHere.has(meaningId) ? sessionId : null,
        learned_via_topic_id: learnedHere.has(meaningId) ? viaTopics.get(meaningId) ?? null : null,
        last_reviewed_at: state.lastReviewedAt,
        next_review_at: state.nextReviewAt,
        stability: state.stability,
        difficulty: state.difficulty,
        lapse_count: state.lapseCount,
      })),
      consumed: evaluated.flatMap((e) => e.receiptId ?? []),
    });
    return this.repository.writeCommit(tx, { userId, sessionId, now, requestHash, response, data, withScopeEvents, withNeedPractice });
  }
}
