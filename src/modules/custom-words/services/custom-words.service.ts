import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import {
  CUSTOM_MEANING_STATUS, CUSTOM_WORD_LOOKUP_RESULT, CustomMeaningStatus, DEFAULT_ACCENT, LEXICAL_DRAFT_KIND, LexicalDraftKind, MEANING_POPULARITY,
} from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { POLICY } from '../../../config/policy';
import { hasValidHighlight, PublicationService } from '../../admin/services/publication.service';
import { MeaningOverride } from '../../practice-resolver/meaning-override';
import { ExampleView, MeaningSnapshot } from '../../practice-resolver/task.types';
import { AudioStorage } from '../providers/audio-storage';
import { audioKey, contextKey, locateTarget, normalizeText, translationKey } from '../domain/custom-word-text';
import { AddRequest, LookupRequest, OverrideRequest } from '../dto/custom-words.schemas';
import { CustomWordsRepository, DraftKey, WordMatch } from '../repositories/custom-words.repository';
import { GeneratedWord, LexicalProvider, SourceMeaning, TranslationDraftPayload, WordDraftPayload } from '../providers/lexical.provider';
import { TtsProvider } from '../providers/tts.provider';

const { maxSensesPerDraft } = POLICY.customWords;
const WORD_CONTEXT_KEY = '';

const statusOf = (match: WordMatch): CustomMeaningStatus => {
  if (match.snapshot) return CUSTOM_MEANING_STATUS.AVAILABLE;
  // Recalled or still with an editor: never published on the admin's behalf.
  return match.sourceSnapshot && !match.recalled && !match.hasLocalization ? CUSTOM_MEANING_STATUS.TRANSLATION_DRAFT : CUSTOM_MEANING_STATUS.UNAVAILABLE;
};

const sourceOf = (lemma: string, partOfSpeech: string, snapshot: MeaningSnapshot): SourceMeaning => ({
  lemma, partOfSpeech, meaningText: snapshot.meaningText, definitionText: snapshot.definitionText, examples: snapshot.examples.map((e) => e.text),
});

// Translation drafts keep sentences only; the client needs the highlight to edit them before adding.
function withLocators(draft?: TranslationDraftPayload, source?: MeaningSnapshot | null): ExampleView[] | undefined {
  const located = new Map(source?.examples.map((e) => [e.text, e.targetLocator]));
  return draft?.examples.flatMap((e) => {
    const targetLocator = located.get(e.text);
    return targetLocator ? [{ ...e, targetLocator }] : [];
  });
}

// Structured output cannot carry a range, so the model's score is clamped here.
const clampPopularity = (value: number) => Math.min(MEANING_POPULARITY.MAX, Math.max(MEANING_POPULARITY.MIN, Math.round(value)));

/** Drops examples whose target is not in the sentence, then senses left without one: publish would reject them. */
function toPayload(generated: GeneratedWord, duplicateOfMeaningId: string | null = null): WordDraftPayload {
  const senses = generated.senses.slice(0, maxSensesPerDraft).flatMap((sense) => {
    const examples = sense.examples.flatMap(({ text, translation, target }) => {
      const targetLocator = locateTarget(text, target);
      return targetLocator && translation.trim() ? [{ text, translation, targetLocator }] : [];
    });
    return examples.length > 0 && sense.ipa.trim() && sense.meaningText.trim() && sense.definitionText.trim() ? [{ ...sense, popularity: clampPopularity(sense.popularity), examples }] : [];
  });
  return { isValidWord: generated.isValidWord && senses.length > 0, lemma: generated.lemma.trim(), duplicateOfMeaningId, senses };
}

function assertEdits(edits: MeaningOverride) {
  if (edits.examples?.some((e) => !hasValidHighlight(e.text, e.targetLocator))) {
    throw new ApiError('VALIDATION_FAILED', 'Example highlight is outside the sentence');
  }
}

@Injectable()
export class CustomWordsService {
  private readonly logger = new Logger(CustomWordsService.name);

  constructor(
    private readonly repository: CustomWordsRepository,
    private readonly publications: PublicationService,
    private readonly lexical: LexicalProvider,
    private readonly tts: TtsProvider,
    private readonly storage: AudioStorage,
    private readonly clock: Clock,
  ) {}

  async lookup(userId: string, { text, context }: LookupRequest) {
    const locale = await this.repository.locale(userId);
    const normalized = normalizeText(text);
    const matches = await this.repository.findMatches(normalized, userId, locale);
    if (matches.length > 0) {
      return context ? this.draftNewMeaning(userId, matches, context, locale) : this.existing(userId, matches, locale);
    }

    const draft = await this.repository.findDraft(normalized, locale, WORD_CONTEXT_KEY) ?? await this.generateWord(userId, text, normalized, locale);
    if (!draft.payload.isValidWord) return { result: CUSTOM_WORD_LOOKUP_RESULT.INVALID };

    // The typed form may be inflected: "ran" must land on an existing "run".
    const lemma = normalizeText(draft.payload.lemma);
    if (lemma !== normalized) {
      const lemmaMatches = await this.repository.findMatches(lemma, userId, locale);
      if (lemmaMatches.length > 0) return this.existing(userId, lemmaMatches, locale);
    }
    return { result: CUSTOM_WORD_LOOKUP_RESULT.DRAFT, draftId: draft.id, lemma: draft.payload.lemma, senses: draft.payload.senses };
  }

  private async generateWord(userId: string, text: string, normalized: string, locale: string) {
    const payload = toPayload(await this.generate(userId, { text, locale, maxSenses: maxSensesPerDraft }));
    const [saved] = await this.repository.saveDrafts([this.draftRow(LEXICAL_DRAFT_KIND.WORD, normalized, locale, WORD_CONTEXT_KEY, payload)]);
    return saved as { id: string; payload: WordDraftPayload };
  }

  private async generate(userId: string, request: Parameters<LexicalProvider['generate']>[0]) {
    await this.repository.consumeLookup(userId, this.today());
    return this.lexical.generate(request);
  }

  private draftRow(kind: LexicalDraftKind, normalizedText: string, locale: string, key: string, payload: DraftKey['payload'], meaningId?: string): DraftKey {
    return { kind, normalizedText, locale, contextKey: key, payload, meaningId, model: this.lexical.model };
  }

  private today() {
    return this.clock.now().toISOString().slice(0, 10);
  }

  private async existing(userId: string, matches: WordMatch[], locale: string) {
    const drafts = await this.translationDrafts(userId, matches, locale);
    return {
      result: CUSTOM_WORD_LOOKUP_RESULT.EXISTING,
      wordId: matches[0].wordId,
      lemma: matches[0].lemma,
      meanings: matches.map((match) => {
        const status = statusOf(match);
        const draft = drafts.get(match.meaningId);
        const shown = match.snapshot ?? draft?.payload;
        const available = status !== CUSTOM_MEANING_STATUS.UNAVAILABLE;
        // Pronunciations don't vary by locale, so a translation draft takes them from the source snapshot.
        const pronunciations = (match.snapshot ?? match.sourceSnapshot)?.pronunciations ?? [];
        return {
          meaningId: match.meaningId,
          status,
          partOfSpeech: match.partOfSpeech,
          inRoadmap: match.inRoadmap,
          learned: match.learned,
          draftId: draft?.id,
          ipa: available ? pronunciations.find((p) => p.accentLocale === DEFAULT_ACCENT)?.ipa : undefined,
          meaningText: available ? shown?.meaningText : undefined,
          definitionText: available ? shown?.definitionText : undefined,
          examples: available ? match.snapshot?.examples ?? withLocators(draft?.payload, match.sourceSnapshot) : undefined,
        };
      }),
    };
  }

  private async translationDrafts(userId: string, matches: WordMatch[], locale: string) {
    const needed = matches.filter((m) => statusOf(m) === CUSTOM_MEANING_STATUS.TRANSLATION_DRAFT);
    const cached = await this.repository.translationDrafts(needed.map((m) => m.meaningId), locale);
    const found = new Map(cached.map((d) => [d.meaningId!, { id: d.id, payload: d.payload as TranslationDraftPayload }]));
    const missing = needed.filter((m) => !found.has(m.meaningId));
    if (missing.length === 0) return found;

    await this.repository.consumeLookup(userId, this.today());
    const translated = await this.translate(missing.map((m) => sourceOf(m.lemma, m.partOfSpeech, m.sourceSnapshot!)), locale);
    const saved = await this.repository.saveDrafts(missing.map((m, i) => ({
      ...this.draftRow(LEXICAL_DRAFT_KIND.TRANSLATION, normalizeText(m.lemma), locale, translationKey(m.meaningId), translated[i], m.meaningId),
      ownerUserId: m.ownerUserId ?? undefined,
    })));
    for (const d of saved) found.set(d.meaningId!, { id: d.id, payload: d.payload as TranslationDraftPayload });
    return found;
  }

  private async translate(sources: SourceMeaning[], locale: string): Promise<TranslationDraftPayload[]> {
    const results = await this.lexical.translate(sources, locale);
    const aligned = results.length === sources.length && results.every((r, i) => r.exampleTranslations.length === sources[i].examples.length);
    if (!aligned) throw new ApiError('LEXICAL_PROVIDER_UNAVAILABLE', 'Translation does not match its source');
    return results.map((r, i) => ({
      meaningText: r.meaningText,
      definitionText: r.definitionText,
      examples: sources[i].examples.map((text, e) => ({ text, translation: r.exampleTranslations[e] })),
    }));
  }

  private async draftNewMeaning(userId: string, matches: WordMatch[], context: string, locale: string) {
    const normalized = normalizeText(matches[0].lemma);
    const key = contextKey(userId, context);
    const usable = matches.filter((m) => m.snapshot);
    const cached = await this.repository.findDraft(normalized, locale, key);
    let draft = cached;
    if (!draft) {
      if (matches.length >= POLICY.customWords.maxMeaningsPerWord) throw new ApiError('CUSTOM_WORD_LIMIT_REACHED', 'Word has too many meanings');
      const generated = await this.generate(userId, {
        text: matches[0].lemma, locale, maxSenses: 1, context, existingMeanings: usable.map((m) => m.snapshot!.meaningText),
      });
      // Stored as an id: the index means nothing once the word gains or loses meanings.
      const duplicate = generated.duplicateOfIndex === null ? undefined : usable[generated.duplicateOfIndex];
      const payload = { ...toPayload(generated, duplicate?.meaningId), lemma: matches[0].lemma };
      const row = { ...this.draftRow(LEXICAL_DRAFT_KIND.MEANING, normalized, locale, key, payload), ownerUserId: userId };
      [draft] = await this.repository.saveDrafts([row]) as { id: string; payload: WordDraftPayload }[];
    }

    const duplicate = usable.find((m) => m.meaningId === draft.payload.duplicateOfMeaningId);
    if (duplicate) return this.existing(userId, [duplicate], locale);
    if (!draft.payload.isValidWord) return { result: CUSTOM_WORD_LOOKUP_RESULT.INVALID };
    return { result: CUSTOM_WORD_LOOKUP_RESULT.NEW_MEANING_DRAFT, draftId: draft.id, lemma: draft.payload.lemma, senses: draft.payload.senses };
  }

  async add(userId: string, body: AddRequest) {
    if (body.edits) assertEdits(body.edits);
    const locale = await this.repository.locale(userId);
    return 'meaningId' in body ? this.attachPublished(userId, body.meaningId, locale, body.edits) : this.confirmDraft(userId, body, locale);
  }

  private async attachPublished(userId: string, meaningId: string, locale: string, edits?: MeaningOverride) {
    if (!(await this.repository.isAttachable(userId, meaningId, locale))) throw new ApiError('CUSTOM_WORD_UNAVAILABLE', 'Meaning is not available in this language');
    return this.repository.transaction(async (tx) => {
      const added = await this.repository.attach(tx, userId, meaningId);
      if (edits) await this.repository.saveOverride(tx, userId, meaningId, locale, edits, this.clock.now());
      return { meaningId, added };
    });
  }

  private async confirmDraft(userId: string, body: Extract<AddRequest, { draftId: string }>, locale: string) {
    // Pool content comes from the stored draft, never from the request.
    const draft = await this.repository.draftById(body.draftId);
    if (!draft || draft.locale !== locale || (draft.ownerUserId && draft.ownerUserId !== userId)) throw new ApiError('CUSTOM_WORD_INVALID', 'Draft not found');
    if (draft.kind === LEXICAL_DRAFT_KIND.TRANSLATION) return this.confirmTranslation(userId, draft, locale, body.edits);

    const payload = draft.payload as WordDraftPayload;
    const sense = payload.senses[body.senseIndex];
    if (!payload.isValidWord || !sense) throw new ApiError('CUSTOM_WORD_INVALID', 'Draft has no such sense');

    const normalized = normalizeText(payload.lemma);
    const audioUrl = await this.repository.hasPronunciation(normalized, sense.partOfSpeech) ? null : await this.audioFor(payload.lemma);
    return this.repository.transaction(async (tx) => {
      const { meaningId, created } = await this.repository.addSense(tx, {
        kind: draft.kind, draftId: draft.id, senseIndex: body.senseIndex, userId, locale, lemma: payload.lemma, normalized, sense, audioUrl,
      });
      if (created) await this.publications.publish(meaningId, locale, tx);
      const added = await this.repository.attach(tx, userId, meaningId);
      if (body.edits) await this.repository.saveOverride(tx, userId, meaningId, locale, body.edits, this.clock.now());
      return { meaningId, added };
    });
  }

  private async confirmTranslation(userId: string, draft: { meaningId: string | null; payload: unknown }, locale: string, edits?: MeaningOverride) {
    const meaningId = draft.meaningId!;
    return this.repository.transaction(async (tx) => {
      const needsPublish = await this.repository.addTranslation(tx, meaningId, locale, draft.payload as TranslationDraftPayload);
      if (needsPublish) await this.publications.publish(meaningId, locale, tx);
      const added = await this.repository.attach(tx, userId, meaningId);
      if (edits) await this.repository.saveOverride(tx, userId, meaningId, locale, edits, this.clock.now());
      return { meaningId, added };
    });
  }

  // Audio is optional: the planner falls back to text and the worker retries.
  private async audioFor(lemma: string) {
    try {
      return await this.synthesize(lemma);
    } catch (error) {
      this.logger.warn(`audio skipped: ${(error as Error).message}`);
      return null;
    }
  }

  private async synthesize(lemma: string) {
    const audio = await this.tts.synthesize(lemma);
    return this.storage.upload(audioKey(this.tts.voice, DEFAULT_ACCENT, lemma), audio);
  }

  async list(userId: string) {
    const locale = await this.repository.locale(userId);
    return { words: await this.repository.list(userId, locale) };
  }

  async setOverride(userId: string, meaningId: string, content: OverrideRequest) {
    assertEdits(content);
    if (!(await this.repository.inRoadmap(userId, meaningId))) throw new ApiError('NOT_FOUND', 'Meaning is not in the roadmap');
    const locale = await this.repository.locale(userId);
    await this.repository.saveOverride(undefined, userId, meaningId, locale, content, this.clock.now());
    return { meaningId, overridden: true };
  }

  async clearOverride(userId: string, meaningId: string) {
    await this.repository.removeOverride(userId, meaningId, await this.repository.locale(userId));
    return { meaningId, overridden: false };
  }

  async remove(userId: string, meaningId: string) {
    if (!(await this.repository.detach(userId, meaningId))) throw new ApiError('NOT_FOUND', 'Meaning is not in the roadmap');
    return { meaningId, removed: true };
  }

  /** One meaning per call. Returns false when nothing was pending. */
  async translateNextPending() {
    const next = await this.repository.nextUntranslated();
    if (!next) return false;
    const [translated] = await this.translate([sourceOf(next.lemma, next.partOfSpeech, next.snapshot)], next.locale);
    await this.repository.transaction(async (tx) => {
      if (await this.repository.addTranslation(tx, next.meaningId, next.locale, translated)) {
        await this.publications.publish(next.meaningId, next.locale, tx);
      }
    });
    return true;
  }

  /** One job per call, so a tick never publishes in a loop. */
  async repairNextAudio() {
    const stale = await this.repository.nextStaleSnapshot();
    if (stale) {
      await this.publications.publish(stale.meaningId, stale.locale);
      return true;
    }
    const missing = await this.repository.nextMissingAudio();
    if (!missing) return false;
    await this.repository.setAudio(missing.id, await this.synthesize(missing.lemma));
    return true;
  }
}
