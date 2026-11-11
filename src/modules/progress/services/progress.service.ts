import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { DEFAULT_ACCENT, Skill, SKILL, SKILL_STATUS } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';
import { toDate } from '../../../db/db';
import { resolveAudioUrl } from '../../practice-resolver/asset-url';
import { applyOverride } from '../../practice-resolver/meaning-override';
import { MeaningSnapshot } from '../../practice-resolver/task.types';
import { EvidenceQueryRow, ProgressRepository, RawMeaningRow } from '../repositories/progress.repository';
import { deriveSkillStatus, EvidenceRow, isWordFullyVerified, SkillState } from '../../skill-verification/skill-evidence';

interface MeaningRow {
  wordId: string;
  meaningId: string;
  snapshot: MeaningSnapshot;
  learnedAt: Date | null;
  nextReviewAt: Date | null;
}

const parseMeaningRows = (rows: RawMeaningRow[]): MeaningRow[] =>
  rows.map(({ override, ...r }) => ({
    ...r,
    snapshot: applyOverride(r.snapshot, override ?? undefined),
    learnedAt: r.learnedAt ? toDate(r.learnedAt) : null,
    nextReviewAt: r.nextReviewAt ? toDate(r.nextReviewAt) : null,
  }));

type EvidenceIndex = Map<string, EvidenceRow[]>;

const scopeKey = (skill: Skill, id: string) => `${skill}:${id}`;

const indexEvidence = (rows: EvidenceQueryRow[]) =>
  Map.groupBy(rows, (r) => scopeKey(r.skill, (r.meaningId ?? r.pronunciationId)!)) as EvidenceIndex;

const stateOf = (index: EvidenceIndex, skill: Skill, id: string): SkillState =>
  deriveSkillStatus(index.get(scopeKey(skill, id)) ?? []);

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

function meaningView(row: MeaningRow, index: EvidenceIndex, allowPlaceholderAudio: boolean) {
  const pronunciation = defaultPronunciation(row.snapshot);
  const reading = stateOf(index, SKILL.READING, row.meaningId);
  const writing = stateOf(index, SKILL.WRITING, row.meaningId);
  const listening = pronunciation ? stateOf(index, SKILL.LISTENING, pronunciation.id) : undefined;
  const speaking = pronunciation ? stateOf(index, SKILL.SPEAKING, pronunciation.id) : undefined;
  return {
    meaningId: row.meaningId,
    meaning: senseView(row.snapshot, allowPlaceholderAudio),
    learnedAt: row.learnedAt,
    nextReviewAt: row.nextReviewAt,
    skills: { reading, writing, listening, speaking },
    needsPractice: [reading, writing, listening, speaking].some((s) => s?.needsPractice),
  };
}

function wordView(rows: MeaningRow[], index: EvidenceIndex, allowPlaceholderAudio: boolean) {
  const meanings = rows.map((row) => meaningView(row, index, allowPlaceholderAudio));
  const learned = meanings.filter((m) => m.learnedAt);
  return {
    wordId: rows[0].wordId,
    lemma: rows[0].snapshot.lemma,
    meanings,
    needsPractice: learned.some((m) => m.needsPractice),
    fullyVerified: isWordFullyVerified({
      learnedMeaningCount: learned.length,
      readingWriting: learned.flatMap((m) => [m.skills.reading.status, m.skills.writing.status]),
      listeningSpeaking: learned.flatMap((m) => [m.skills.listening?.status ?? SKILL_STATUS.NOT_VERIFIED, m.skills.speaking?.status ?? SKILL_STATUS.NOT_VERIFIED] as const),
    }),
  };
}

/** The library row: content and review dates only, so listing never reads skill evidence. */
const wordSummary = (rows: MeaningRow[], meaningCount: number, allowPlaceholderAudio: boolean) => ({
  wordId: rows[0].wordId,
  lemma: rows[0].snapshot.lemma,
  meaningCount,
  meanings: rows.map((row) => ({
    meaningId: row.meaningId,
    meaning: senseView(row.snapshot, allowPlaceholderAudio),
    learnedAt: row.learnedAt,
    nextReviewAt: row.nextReviewAt,
  })),
});

@Injectable()
export class ProgressService {
  constructor(private readonly repository: ProgressRepository, private readonly clock: Clock, private readonly config: AppConfig) {}

  learnHome(userId: string) {
    return this.repository.learnHomeCounts(userId, this.clock.now());
  }

  async words(userId: string, limit: number, offset: number, query?: string) {
    const rows = await this.repository.learnedWordsPage(userId, limit, offset, query);
    const counts = new Map(rows.map((r) => [r.wordId, r.meaningCount]));
    const groups = Map.groupBy(parseMeaningRows(rows), (r) => r.wordId).values();
    return { words: [...groups].map((group) => wordSummary(group, counts.get(group[0].wordId)!, this.config.allowPlaceholderAudio)) };
  }

  wordStats(userId: string) {
    return this.repository.wordStats(userId);
  }

  async word(userId: string, wordId: string) {
    const rows = await this.repository.wordMeanings(userId, wordId);
    if (rows.length === 0) throw new ApiError('NOT_FOUND', 'Word not found');
    const meanings = parseMeaningRows(rows);
    const evidence = await this.repository.evidence(userId, meanings.map((m) => m.meaningId), meanings.flatMap((m) => m.snapshot.pronunciations.map((p) => p.id)));
    return wordView(meanings, indexEvidence(evidence), this.config.allowPlaceholderAudio);
  }
}
