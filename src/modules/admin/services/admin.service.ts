import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { AiMeaningScope, DEFAULT_ACCENT, EDITORIAL_STATE, ITEM_STATUS, PROMPT_TYPE, Template, TEMPLATE_VARIANTS, Variant } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { AppConfig } from '../../../config/app-config';
import { CuratedItem, curatedContentSchema, resolveCurated } from '../../practice-resolver/curated';
import { AdminPracticeItemsRepository } from '../repositories/admin-practice-items.repository';
import { PRIVATE_MEANING_LOCKED } from '../domain/admin.errors';
import { AdminRepository } from '../repositories/admin.repository';
import { CreateItem, CreateWord, ItemLocale, MeaningLocale } from '../dto/admin.schemas';

@Injectable()
export class AdminService {
  constructor(
    private readonly repository: AdminRepository,
    private readonly items: AdminPracticeItemsRepository,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  async createWord(body: CreateWord) {
    const wordId = newId();
    const types = body.types.map((type) => ({
      ...type,
      id: newId(),
      pronunciations: type.pronunciations.map((p) => ({ ...p, id: newId() })),
      meanings: type.meanings.map((meaning) => ({
        ...meaning,
        id: newId(),
        examples: meaning.examples.map((example) => ({ ...example, id: newId() })),
      })),
    }));
    const typeMeanings = types.flatMap((t) => t.meanings.map((m) => ({ ...m, typeId: t.id })));
    await this.repository.insertWordTree({
      word: { id: wordId, language: body.language, lemma: body.lemma, homographKey: body.homographKey },
      types: types.map(({ id, partOfSpeech }) => ({ id, wordId, partOfSpeech })),
      pronunciations: types.flatMap((t) => t.pronunciations.map((p) => ({ ...p, typeId: t.id }))),
      meanings: typeMeanings.map(({ id, typeId, cefrLevel, coreDefinition }) => ({ id, typeId, cefrLevel, coreDefinition })),
      examples: typeMeanings.flatMap((m) =>
        m.examples.map(({ id, sourceText, targetLocator }) => ({ id, meaningId: m.id, sourceText, targetLocator })),
      ),
    });
    return { wordId, types };
  }

  // Stored AI text only: a learner's edits live in user_meaning_overrides and never appear here.
  aiMeanings(scope: AiMeaningScope, limit: number, offset: number) {
    return this.repository.aiMeanings(scope, limit, offset);
  }

  async approveAiMeaning(meaningId: string, reviewerId: string) {
    if (!(await this.repository.approveAiMeaning(meaningId, reviewerId, this.clock.now()))) throw new ApiError('NOT_FOUND', 'No AI meaning awaiting review');
    return { meaningId, approved: true };
  }

  async putMeaningLocale(meaningId: string, locale: string, body: MeaningLocale) {
    const meaning = await this.repository.findMeaningOwner(meaningId);
    if (!meaning) throw new ApiError('NOT_FOUND', 'Meaning not found');
    if (meaning.ownerUserId) throw new ApiError('CONTENT_LOCKED', PRIVATE_MEANING_LOCKED);
    const exampleIds = body.exampleTranslations.map((t) => t.exampleId);
    if ((await this.repository.countExamplesOf(meaningId, exampleIds)) !== exampleIds.length) {
      throw new ApiError('VALIDATION_FAILED', 'Example does not belong to this Meaning');
    }
    await this.repository.upsertMeaningLocale(meaningId, locale, body, this.clock.now());
    return { meaningId, locale, editorialState: body.editorialState };
  }

  async createItem(body: CreateItem) {
    if (!TEMPLATE_VARIANTS[body.template as Template].includes(body.variant as Variant)) {
      throw new ApiError('TASK_DATA_INVALID', `Variant ${body.variant} is not valid for ${body.template}`);
    }
    if (!curatedContentSchema.safeParse(body.sourceContent).success) throw new ApiError('TASK_DATA_INVALID', 'promptVariants missing');

    const { targets, ...item } = body;
    await this.assertAligned(targets);
    const id = newId();
    await this.items.insert(id, item, targets);
    return { id };
  }

  // C52: a dual target must point at the same Word/Type. Items are shared content, so a private meaning cannot be a target.
  async assertAligned(targets: CreateItem['targets']) {
    if ((await this.items.countMissingTargets(targets)) > 0) throw new ApiError('TASK_DATA_INVALID', 'Target does not exist or is private');
    const dual = targets.filter((t) => t.meaningId && t.pronunciationId);
    if (dual.length === 0) return;
    if ((await this.items.countAlignedTargets(dual)) !== dual.length) throw new ApiError('TASK_DATA_INVALID', 'Meaning and pronunciation targets differ in Word/Type');
  }

  async putItemLocale(practiceItemId: string, locale: string, body: ItemLocale) {
    const approvedAt = body.editorialState === EDITORIAL_STATE.APPROVED ? this.clock.now() : null;
    await this.items.upsertLocale(practiceItemId, locale, body, approvedAt);
    return { practiceItemId, locale, editorialState: body.editorialState };
  }

  async publishItem(id: string) {
    const item = await this.items.findForPublish(id);
    if (!item) throw new ApiError('NOT_FOUND', 'Practice item not found');
    if (item.status === ITEM_STATUS.RETIRED) throw new ApiError('CONTENT_LOCKED', 'A retired item cannot be published again; create a new revision');
    if (item.targets.length === 0) throw new ApiError('TASK_DATA_INVALID', 'Item has no target');
    if (item.approved.length === 0) throw new ApiError('TASK_DATA_INVALID', 'Item has no approved locale');
    const unservable = item.approved.find(({ locale, content }) => !this.isServable({ ...item, id, localizedContent: content }, locale));
    if (unservable) throw new ApiError('TASK_DATA_INVALID', `Item cannot be served in ${unservable.locale}: check sourceContent, sourceEvaluation and the localized content`);

    await this.items.publish(id, this.clock.now(), item.supersedesItemId);
    return { id, status: ITEM_STATUS.PUBLISHED };
  }

  // Same check the planner applies at serve time, where a bad item would be dropped without a trace.
  private isServable(item: CuratedItem, locale: string) {
    const ctx = { locale, accent: DEFAULT_ACCENT, audioPlayback: true, allowPlaceholderAudio: this.config.allowPlaceholderAudio };
    return [PROMPT_TYPE.TEXT, PROMPT_TYPE.AUDIO].some((promptType) => resolveCurated(item, promptType, ctx) !== null);
  }
}
