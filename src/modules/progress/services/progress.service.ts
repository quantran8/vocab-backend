import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { DEFAULT_ACCENT, SPEAKING_STATUS } from '../../../common/constants/domain';
import { MS_PER_DAY } from '../../../common/constants/time';
import { activeOverride, effectiveNewWords, reviewsPerSession, scopeStatus, shouldPromptChoice } from '../../review-load/domain/review-load';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';
import { toDate } from '../../../db/db';
import { resolveAudioUrl } from '../../practice-resolver/asset-url';
import { applyOverride } from '../../practice-resolver/meaning-override';
import { MeaningSnapshot } from '../../practice-resolver/task.types';
import { LearnHomeRow, ProgressRepository, RawMeaningRow, RawWordMeaningRow } from '../repositories/progress.repository';
import { retrievability } from '../../memory-srs/fsrs';
import { freeRemaining, type PlanView } from '../../entitlement/domain/entitlement';
import { EntitlementService } from '../../entitlement/services/entitlement.service';

interface MeaningRow {
  wordId: string;
  meaningId: string;
  snapshot: MeaningSnapshot;
  learnedAt: Date | null;
  nextReviewAt: Date | null;
  lastReviewedAt?: Date | null;
  stability?: number | null;
}

const parseMeaningRows = <T extends RawMeaningRow>(rows: T[]) =>
  rows.map(({ override, ...r }) => ({
    ...r,
    snapshot: applyOverride(r.snapshot, override ?? undefined),
    learnedAt: r.learnedAt ? toDate(r.learnedAt) : null,
    nextReviewAt: r.nextReviewAt ? toDate(r.nextReviewAt) : null,
    lastReviewedAt: r.lastReviewedAt ? toDate(r.lastReviewedAt) : null,
  }));

/** How well the word holds now, for the word detail; null until learned. */
function memoryView(row: MeaningRow, now: Date) {
  if (!row.learnedAt || row.stability == null) return null;
  const since = (now.getTime() - (row.lastReviewedAt ?? row.learnedAt).getTime()) / MS_PER_DAY;
  return { stabilityDays: row.stability, retrievability: Math.round(retrievability(since, row.stability) * 1000) / 1000, nextReviewAt: row.nextReviewAt };
}

const defaultPronunciation = (snapshot: MeaningSnapshot) => snapshot.pronunciations.find((p) => p.accentLocale === DEFAULT_ACCENT);

function senseView(snapshot: MeaningSnapshot, allowPlaceholderAudio: boolean) {
  const pronunciation = defaultPronunciation(snapshot);
  const audioUrl = resolveAudioUrl(pronunciation?.audioUrl, allowPlaceholderAudio);
  return {
    partOfSpeech: snapshot.partOfSpeech,
    text: snapshot.meaningText,
    ipa: pronunciation?.ipa,
    definition: snapshot.definitionText,
    ...(pronunciation && audioUrl && { audio: { url: audioUrl, locale: pronunciation.accentLocale } }),
    examples: snapshot.examples.map(({ text, translation }) => ({ text, translation })),
  };
}

type WordMeaningRow = MeaningRow & Pick<RawWordMeaningRow, 'needsPractice' | 'speaking'>;

/** Null when the Meaning has no pronunciation to record. */
function speakingView(row: WordMeaningRow) {
  if (!defaultPronunciation(row.snapshot)) return null;
  const { speaking } = row;
  if (!speaking) return { status: SPEAKING_STATUS.NOT_TRIED, lastScore: null, bestScore: null, lastAssessedAt: null };
  return { ...speaking, lastAssessedAt: toDate(speaking.lastAssessedAt) };
}

function meaningView(row: WordMeaningRow, allowPlaceholderAudio: boolean, now: Date) {
  return {
    meaningId: row.meaningId,
    meaning: senseView(row.snapshot, allowPlaceholderAudio),
    learnedAt: row.learnedAt,
    nextReviewAt: row.nextReviewAt,
    memory: memoryView(row, now),
    speaking: speakingView(row),
    // Removed for one release: older clients still find the key.
    skills: null,
    needsPractice: row.needsPractice,
  };
}

function wordView(rows: WordMeaningRow[], allowPlaceholderAudio: boolean, now: Date) {
  const meanings = rows.map((row) => meaningView(row, allowPlaceholderAudio, now));
  return {
    wordId: rows[0].wordId,
    lemma: rows[0].snapshot.lemma,
    meanings,
    needsPractice: meanings.some((m) => m.learnedAt && m.needsPractice),
  };
}

/** Over every visible Meaning, learned or not; a Meaning without IPA counts as its own pronunciation. */
const ipaVaries = (senses: Pick<RawMeaningRow, 'snapshot' | 'override'>[]) =>
  new Set(senses.map(({ snapshot, override }) => defaultPronunciation(applyOverride(snapshot, override ?? undefined))?.ipa ?? '')).size > 1;

/** The library row: content and review dates only, so listing never reads progress detail. */
const wordSummary = (rows: MeaningRow[], meaningCount: number, ipaVaries: boolean, allowPlaceholderAudio: boolean) => ({
  wordId: rows[0].wordId,
  lemma: rows[0].snapshot.lemma,
  meaningCount,
  ipaVaries,
  meanings: rows.map((row) => ({
    meaningId: row.meaningId,
    meaning: senseView(row.snapshot, allowPlaceholderAudio),
    learnedAt: row.learnedAt,
    nextReviewAt: row.nextReviewAt,
  })),
});

function learnHomeView(row: LearnHomeRow, now: Date, plan: PlanView) {
  const { remaining, pendingCustom, topics, dailyNewWordGoal, reviewsPerSession: chosenReviews, autoBalanceNewWords, overrideValue, overrideMode, overrideUntil, lastPromptedBacklog, ...counts } = row;
  const backlog = counts.dueCount;
  const stored = overrideValue === null || overrideMode === null
    ? null
    : { value: overrideValue, mode: overrideMode, until: overrideUntil === null ? null : toDate(overrideUntil) };
  const override = activeOverride(stored, now);
  const free = freeRemaining(plan);
  const budget = effectiveNewWords({ goal: dailyNewWordGoal, override, autoBalance: autoBalanceNewWords, backlog, remaining, pendingCustom, freeRemaining: free, now });
  const status = scopeStatus(remaining, budget.chosen, counts.checkpointSessionsRequired);
  return {
    ...counts,
    scope: { ...status, remainingNewMeanings: remaining, pendingCustomMeanings: pendingCustom, topics },
    reviewLoad: {
      backlog,
      dueCap: reviewsPerSession(chosenReviews, dailyNewWordGoal),
      effectiveNewPerSession: budget.value,
      newWordReason: budget.reason,
      override,
      autoBalance: autoBalanceNewWords,
      promptChoice: shouldPromptChoice(backlog, lastPromptedBacklog),
    },
    // Free tier only: how many of its new words the learner has used.
    freeAllowance: plan.limits && { used: plan.limits.newWordsUsed, max: plan.limits.maxNewWords, remaining: free },
  };
}

@Injectable()
export class ProgressService {
  constructor(
    private readonly repository: ProgressRepository,
    private readonly entitlements: EntitlementService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  async learnHome(userId: string) {
    const now = this.clock.now();
    const [row, plan] = await Promise.all([this.repository.learnHomeCounts(userId, now), this.entitlements.plan(userId, now)]);
    if (!row) throw new ApiError('NOT_FOUND', 'Settings not found');
    return learnHomeView(row, now, plan);
  }

  async words(userId: string, limit: number, offset: number, query?: string) {
    const rows = await this.repository.learnedWordsPage(userId, limit, offset, query);
    const totals = new Map(rows.map((r) => [r.wordId, r]));
    const groups = Map.groupBy(parseMeaningRows(rows), (r) => r.wordId).values();
    return {
      words: [...groups].map((group) => {
        const { meaningCount, senses } = totals.get(group[0].wordId)!;
        return wordSummary(group, meaningCount, ipaVaries(senses), this.config.allowPlaceholderAudio);
      }),
    };
  }

  wordStats(userId: string) {
    return this.repository.wordStats(userId, this.clock.now());
  }

  async word(userId: string, wordId: string) {
    const now = this.clock.now();
    const rows = await this.repository.wordMeanings(userId, wordId, now);
    if (rows.length === 0) throw new ApiError('NOT_FOUND', 'Word not found');
    return wordView(parseMeaningRows(rows), this.config.allowPlaceholderAudio, now);
  }
}
