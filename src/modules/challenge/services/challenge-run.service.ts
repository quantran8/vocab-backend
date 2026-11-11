import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import {
  CHALLENGE_LEVEL_STATE, CHALLENGE_NEXT_ACTION, CHALLENGE_OUTCOME, CHALLENGE_ROLE, CHALLENGE_RUN_STATUS, CHALLENGE_UNLOCK, GAME_MODE,
} from '../../../common/constants/domain';
import { addMinutes } from '../../../common/constants/time';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { POLICY } from '../../../config/policy';
import { Tx } from '../../../db/db';
import { canonicalHash } from '../../session-commit/domain/canonical';
import { levelStates } from '../domain/challenge-map';
import { composeChapter, repairSlots } from '../domain/chapter-content';
import { buildPlan, buildQueue, LevelRule, replay, RunPlan, RunResult } from '../domain/match-madness';
import { CommitRunBody } from '../dto/challenge.schemas';
import { ChallengeRepository, LevelProgressRow } from '../repositories/challenge.repository';
import { eligibleCount, toCandidates } from './challenge-map.service';

const { challenge } = POLICY;
const LEVELS: readonly LevelRule[] = challenge.levels;
const LAST_LEVEL = LEVELS.length;
type LoadedRun = NonNullable<Awaited<ReturnType<ChallengeRepository['loadRun']>>>;

/** What the client may see of a plan: Meaning ids stay on the server. */
const runView = (runId: string, run: { status: string; chapterNo: number; levelNo: number; contentVersion: number; expiresAt: Date }, plan: RunPlan) => ({
  runId,
  status: run.status,
  gameMode: GAME_MODE.MATCH_MADNESS,
  chapterNo: run.chapterNo,
  levelNo: run.levelNo,
  policyVersion: challenge.version,
  contentVersion: run.contentVersion,
  explanationLocale: plan.explanationLocale,
  goalMatches: plan.goalMatches,
  visiblePairs: plan.visiblePairs,
  timeLimitMs: plan.timeLimitMs,
  starCriteria: plan.starCriteria,
  minMatchesBetweenRepeats: challenge.minMatchesBetweenRepeats,
  score: plan.score ?? challenge.score,
  boardSeed: plan.boardSeed,
  pairs: plan.pairs.map(({ meaningId: _meaningId, ...pair }) => pair),
  expiresAt: run.expiresAt.toISOString(),
});

@Injectable()
export class ChallengeRunService {
  constructor(private readonly repository: ChallengeRepository, private readonly clock: Clock) {}

  issue(userId: string, chapterNo: number, levelNo: number) {
    const level = LEVELS[levelNo - 1];
    if (!level) throw new ApiError('CHALLENGE_LEVEL_LOCKED', 'No such level');
    return this.repository.transaction(async (tx) => {
      await this.repository.lockUser(tx, userId);
      const now = this.clock.now();
      const open = await this.repository.openRun(tx, userId, now);
      if (open) throw new ApiError('CHALLENGE_RUN_ACTIVE', 'Another run is still open', { runId: open });

      const state = await this.repository.issueState(tx, userId, chapterNo);
      const chapter = state.chapter
        ? await this.prepareChapter(tx, userId, chapterNo, levelNo, { ...state, chapter: state.chapter }, now)
        : await this.materialize(tx, userId, chapterNo, levelNo, state, now);

      const core = chapter.slots.filter((s) => s.role === CHALLENGE_ROLE.CORE);
      const review = chapter.slots.filter((s) => s.role === CHALLENGE_ROLE.REVIEW);
      const seed = randomBytes(16).toString('hex');
      const queue = buildQueue({ seed, level, rules: challenge, core, review });
      if (!queue) throw new ApiError('CHALLENGE_CONTENT_UNAVAILABLE', 'The chapter cannot fill this level');
      const plan = buildPlan({ seed, explanationLocale: chapter.explanationLocale, level, rules: challenge, queue, newId });

      const runId = newId();
      const expiresAt = addMinutes(now, challenge.issuedRunTtlMinutes);
      await this.repository.insertRun(tx, {
        id: runId, userId, chapterId: chapter.id, levelNo, gameMode: GAME_MODE.MATCH_MADNESS, policyVersion: challenge.version,
        contentVersion: chapter.contentVersion, status: CHALLENGE_RUN_STATUS.ISSUED, plan, issuedAt: now, expiresAt,
      });
      return runView(runId, { status: CHALLENGE_RUN_STATUS.ISSUED, chapterNo, levelNo, contentVersion: chapter.contentVersion, expiresAt }, plan);
    });
  }

  /** Only the chapter right after the last one, entered at level 1, once the last one is cleared. */
  private async materialize(tx: Tx, userId: string, chapterNo: number, levelNo: number, state: { locale: string; lastChapterNo: number; previousCleared: boolean }, now: Date) {
    if (chapterNo !== state.lastChapterNo + 1 || levelNo !== 1 || !state.previousCleared) {
      throw new ApiError('CHALLENGE_LEVEL_LOCKED', 'This chapter is not open yet');
    }
    const id = newId();
    const pool = await this.repository.candidates(tx, userId, state.locale, chapterNo);
    const slots = composeChapter({
      chapterId: id, coreCount: challenge.chapterNewMeaningCount, reviewCount: challenge.chapterReviewMeaningCount,
      unallocated: toCandidates(pool.unallocated), priorCores: toCandidates(pool.priorCores),
    });
    if (!slots) {
      throw new ApiError('CHALLENGE_NOT_ENOUGH_VOCABULARY', 'Learn more words in Daily first', {
        eligibleNewCount: eligibleCount(pool.unallocated), requiredNewCount: challenge.chapterNewMeaningCount,
      });
    }
    await this.repository.insertChapter(tx, { id, userId, chapterNo, explanationLocale: state.locale, now }, slots);
    return { id, explanationLocale: state.locale, contentVersion: 1, slots };
  }

  /** Checks the level is open, then refills any slot whose Meaning was recalled or removed since. */
  private async prepareChapter(
    tx: Tx, userId: string, chapterNo: number, levelNo: number,
    state: Awaited<ReturnType<ChallengeRepository['issueState']>> & { chapter: { id: string; explanationLocale: string; contentVersion: number } },
    now: Date,
  ) {
    const { chapter, slots } = state;
    if (levelStates(LAST_LEVEL, state.levels)[levelNo - 1].state === CHALLENGE_LEVEL_STATE.LOCKED) {
      throw new ApiError('CHALLENGE_LEVEL_LOCKED', 'Clear the previous level first');
    }
    if (slots.every((s) => s.valid)) return { ...chapter, slots };

    const pool = await this.repository.candidates(tx, userId, chapter.explanationLocale, chapterNo);
    const repair = repairSlots({
      chapterId: chapter.id, slots, unallocated: toCandidates(pool.unallocated), priorCores: toCandidates(pool.priorCores),
    });
    if (!repair) throw new ApiError('CHALLENGE_CONTENT_UNAVAILABLE', 'Some words are no longer available; learn more words to refill this chapter');
    const version = chapter.contentVersion + 1;
    await this.repository.replaceSlots(tx, {
      chapterId: chapter.id, userId, version, retiredIds: repair.retired.map((s) => s.id), added: repair.added, now,
    });
    return { ...chapter, contentVersion: version, slots: [...slots.filter((s) => s.valid), ...repair.added] };
  }

  /** The clock starts here, not at issue; a repeat returns the same start. */
  start(userId: string, runId: string) {
    return this.repository.transaction(async (tx) => {
      const run = await this.ownedRun(tx, userId, runId);
      const now = this.clock.now();
      if (run.status === CHALLENGE_RUN_STATUS.ISSUED) {
        if (run.expiresAt <= now) throw new ApiError('CHALLENGE_RUN_EXPIRED');
        const expiresAt = addMinutes(now, challenge.startedRunCommitTtlMinutes);
        await this.repository.setStatus(tx, runId, { status: CHALLENGE_RUN_STATUS.STARTED, startedAt: now, expiresAt });
        return { runId, status: CHALLENGE_RUN_STATUS.STARTED, startedAt: now.toISOString(), timeLimitMs: challenge.timeLimitMs };
      }
      if (run.status === CHALLENGE_RUN_STATUS.STARTED) {
        return { runId, status: run.status, startedAt: run.startedAt!.toISOString(), timeLimitMs: challenge.timeLimitMs };
      }
      throw this.terminalError(run.status);
    });
  }

  commit(userId: string, runId: string, body: CommitRunBody) {
    const requestHash = canonicalHash(body);
    return this.repository.transaction(async (tx) => {
      await this.repository.lockUser(tx, userId);
      const run = await this.ownedRun(tx, userId, runId);
      if (run.status === CHALLENGE_RUN_STATUS.COMMITTED) {
        if (run.commitRequestSha256 === requestHash) return run.commitResponse;
        throw new ApiError('CHALLENGE_COMMIT_CONFLICT', 'This run was already committed with a different body');
      }
      if (run.status === CHALLENGE_RUN_STATUS.ISSUED) throw new ApiError('CHALLENGE_RUN_NOT_STARTED', 'Start the run first');
      if (run.status !== CHALLENGE_RUN_STATUS.STARTED) throw this.terminalError(run.status);
      const now = this.clock.now();
      if (run.expiresAt <= now) throw new ApiError('CHALLENGE_RUN_EXPIRED');

      // The client clock may lag the server's, never run far ahead of it.
      if (body.endedElapsedMs > now.getTime() - run.startedAt!.getTime() + challenge.clockSlackMs) {
        throw new ApiError('CHALLENGE_INVALID_EVENTS', 'Elapsed time is longer than the run has been open');
      }
      const replayed = replay(run.plan!, challenge, body);
      if (!replayed.ok) throw new ApiError('CHALLENGE_INVALID_EVENTS', replayed.reason);

      const response = await this.settle(tx, userId, runId, run, replayed.result, now);
      await this.repository.setStatus(tx, runId, {
        status: CHALLENGE_RUN_STATUS.COMMITTED, committedAt: now, events: body.events, commitRequestSha256: requestHash,
        commitResponse: response, result: replayed.result,
      });
      return response;
    });
  }

  /** Recovery when the device lost its events: an unstarted run is dropped, a started one ends as a 0-star quit. */
  quit(userId: string, runId: string) {
    return this.repository.transaction(async (tx) => {
      await this.repository.lockUser(tx, userId);
      const run = await this.ownedRun(tx, userId, runId);
      const now = this.clock.now();
      const open = run.status === CHALLENGE_RUN_STATUS.ISSUED || run.status === CHALLENGE_RUN_STATUS.STARTED;
      if (open && run.expiresAt <= now) return { runId, status: CHALLENGE_RUN_STATUS.EXPIRED };
      if (run.status === CHALLENGE_RUN_STATUS.ISSUED) {
        await this.repository.setStatus(tx, runId, { status: CHALLENGE_RUN_STATUS.ABANDONED });
        return { runId, status: CHALLENGE_RUN_STATUS.ABANDONED };
      }
      if (run.status === CHALLENGE_RUN_STATUS.STARTED) {
        const elapsedMs = Math.min(challenge.timeLimitMs, Math.max(0, now.getTime() - run.startedAt!.getTime()));
        const result: RunResult = { outcome: CHALLENGE_OUTCOME.QUIT, starsThisRun: 0, correctMatches: 0, mistakes: 0, longestCombo: 0, elapsedMs, score: 0 };
        const response = await this.settle(tx, userId, runId, run, result, now);
        await this.repository.setStatus(tx, runId, {
          status: CHALLENGE_RUN_STATUS.COMMITTED, committedAt: now, events: [], commitResponse: response, result,
        });
        return { runId, status: CHALLENGE_RUN_STATUS.COMMITTED, response };
      }
      return { runId, status: run.status, ...(run.status === CHALLENGE_RUN_STATUS.COMMITTED && { response: run.commitResponse }) };
    });
  }

  async status(userId: string, runId: string) {
    const run = await this.repository.findRun(userId, runId);
    if (!run) throw new ApiError('CHALLENGE_RUN_NOT_FOUND');
    const open = run.status === CHALLENGE_RUN_STATUS.ISSUED || run.status === CHALLENGE_RUN_STATUS.STARTED;
    const status = open && run.expiresAt <= this.clock.now() ? CHALLENGE_RUN_STATUS.EXPIRED : run.status;
    return {
      runId,
      status,
      chapterNo: run.chapterNo,
      levelNo: run.levelNo,
      startedAt: run.startedAt?.toISOString() ?? null,
      expiresAt: run.expiresAt.toISOString(),
      response: run.commitResponse ?? null,
      // Recovery only: the frozen plan of a run that is still live.
      run: status === run.status && open && run.plan ? runView(runId, { ...run, status }, run.plan) : null,
    };
  }

  /** Counts the attempt, raises bests and says what opened, all from server state. */
  private async settle(tx: Tx, userId: string, runId: string, run: LoadedRun, result: RunResult, now: Date) {
    const cleared = result.outcome === CHALLENGE_OUTCOME.CLEARED;
    await this.repository.recordAttempt(tx, {
      userId, chapterId: run.chapterId, levelNo: run.levelNo, stars: result.starsThisRun, score: result.score,
      completionMs: cleared ? result.elapsedMs : null, now,
    });
    const before: LevelProgressRow | null = run.progress;
    const firstClear = cleared && !before?.firstClearedAt;
    return {
      runId,
      status: CHALLENGE_RUN_STATUS.COMMITTED,
      result: {
        ...result,
        bestStars: Math.max(before?.bestStars ?? 0, result.starsThisRun),
        bestScore: Math.max(before?.bestScore ?? 0, result.score),
      },
      ...(await this.unlock(tx, userId, run, result, firstClear)),
    };
  }

  private async unlock(tx: Tx, userId: string, run: LoadedRun, result: RunResult, firstClear: boolean) {
    const none = { kind: CHALLENGE_UNLOCK.NONE };
    if (result.outcome === CHALLENGE_OUTCOME.FAILED) return { unlock: none, nextAction: CHALLENGE_NEXT_ACTION.RETRY };
    if (!firstClear) return { unlock: none, nextAction: CHALLENGE_NEXT_ACTION.OPEN_MAP };
    if (run.levelNo < LAST_LEVEL) {
      return {
        unlock: { kind: CHALLENGE_UNLOCK.LEVEL, chapterNo: run.chapterNo, levelNo: run.levelNo + 1 },
        nextAction: CHALLENGE_NEXT_ACTION.PLAY_NEXT_LEVEL,
      };
    }
    const chapterNo = run.chapterNo + 1;
    const pool = await this.repository.candidates(tx, userId, run.locale, chapterNo);
    const eligibleNewCount = eligibleCount(pool.unallocated);
    const requiredNewCount = challenge.chapterNewMeaningCount;
    return eligibleNewCount >= requiredNewCount
      ? { unlock: { kind: CHALLENGE_UNLOCK.CHAPTER_READY, chapterNo }, nextAction: CHALLENGE_NEXT_ACTION.PLAY_NEXT_LEVEL }
      : { unlock: { kind: CHALLENGE_UNLOCK.NEEDS_VOCABULARY, chapterNo, eligibleNewCount, requiredNewCount }, nextAction: CHALLENGE_NEXT_ACTION.LEARN_MORE };
  }

  /** Someone else's run looks exactly like a missing one. */
  private async ownedRun(tx: Tx, userId: string, runId: string) {
    const run = await this.repository.loadRun(tx, runId);
    if (!run || run.userId !== userId) throw new ApiError('CHALLENGE_RUN_NOT_FOUND');
    return run;
  }

  private terminalError(status: string) {
    return status === CHALLENGE_RUN_STATUS.COMMITTED
      ? new ApiError('CHALLENGE_COMMIT_CONFLICT', 'This run is already over')
      : new ApiError('CHALLENGE_RUN_EXPIRED', `This run is ${status}`);
  }
}
