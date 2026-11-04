import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { CEFR_LEVELS, EDITORIAL_STATE } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { Executor } from '../../../db/db';
import { MeaningSnapshot } from '../../practice-resolver/task.types';
import { PublicationRepository } from '../repositories/publication.repository';

const reject = (message: string) => new ApiError('PUBLICATION_INVALID', message);

@Injectable()
export class PublicationService {
  constructor(private readonly repository: PublicationRepository, private readonly clock: Clock) {}

  async publish(meaningId: string, locale: string, executor?: Executor) {
    const snapshot = await this.buildSnapshot(meaningId, locale, executor);
    const publicationId = newId();
    const revision = await this.repository.insertRevision({ publicationId, meaningId, locale, snapshot, now: this.clock.now() }, executor);
    return { publicationId, meaningId, locale, revision };
  }

  async recall(meaningId: string, locale: string) {
    if (!(await this.repository.recall(meaningId, locale, this.clock.now()))) throw new ApiError('NOT_FOUND', 'No active publication');
    return { meaningId, locale, recalled: true };
  }

  private async buildSnapshot(meaningId: string, locale: string, executor?: Executor): Promise<MeaningSnapshot> {
    const meaning = await this.repository.findMeaningForSnapshot(meaningId, locale, executor);
    if (!meaning) throw new ApiError('NOT_FOUND', 'Meaning not found');

    const localization = meaning.localizations[0];
    if (!meaning.cefrLevel || !(CEFR_LEVELS as readonly string[]).includes(meaning.cefrLevel)) throw reject('CEFR level missing');
    if (!localization?.meaningText.trim() || !localization.definitionText.trim()) throw reject('Localized meaning or definition missing');
    if (localization.editorialState !== EDITORIAL_STATE.APPROVED) throw reject('Localization is not approved');

    const pronunciations = meaning.type.pronunciations;
    if (pronunciations.length === 0 || pronunciations.some((p) => !p.ipa?.trim())) throw reject('IPA missing');

    const examples = meaning.examples.flatMap((e) => {
      const translation = e.localizations[0]?.translationText;
      return translation?.trim() && hasValidHighlight(e.sourceText, e.targetLocator)
        ? [{ text: e.sourceText, translation, targetLocator: e.targetLocator }]
        : [];
    });
    if (examples.length === 0) throw reject('No usable localized example');

    const { word, ...type } = meaning.type;
    return {
      wordId: word.id,
      lemma: word.lemma,
      typeId: type.id,
      partOfSpeech: type.partOfSpeech,
      meaningId: meaning.id,
      cefrLevel: meaning.cefrLevel,
      meaningText: localization.meaningText,
      definitionText: localization.definitionText,
      pronunciations: pronunciations.map((p) => ({ id: p.id, accentLocale: p.accentLocale, ipa: p.ipa!, audioUrl: p.audioAssetKey })),
      examples,
    };
  }
}

export function hasValidHighlight(text: string, locator: unknown) {
  const { start, end } = (locator ?? {}) as { start?: unknown; end?: unknown };
  return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (start as number) < (end as number) && (end as number) <= text.length;
}
