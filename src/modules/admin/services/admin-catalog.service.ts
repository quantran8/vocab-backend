import { Injectable } from '@nestjs/common';
import { CONTENT_STATUS, DEFAULT_LOCALE, PERSONAL_COLLECTION_SLUG } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { AdminCatalogRepository } from '../repositories/admin-catalog.repository';
import { CatalogLocale, CreateCatalogEntry, PatchCatalogEntry } from '../dto/admin.schemas';

const DRAFT_DELETE_ONLY = 'Only a draft can be deleted; archive it instead';
const COLLECTION_NOT_FOUND = 'Collection not found';
const TOPIC_NOT_FOUND = 'Topic not found';
const SLUG_RESERVED = 'This slug is reserved';
const LOCALE_NOT_FOUND = 'Locale not found';

@Injectable()
export class AdminCatalogService {
  constructor(private readonly repository: AdminCatalogRepository) {}

  listCollections(limit: number, offset: number) {
    return this.repository.listCollections(limit, offset);
  }

  async getCollection(id: string) {
    const collection = await this.repository.findCollection(id);
    if (!collection) throw new ApiError('NOT_FOUND', COLLECTION_NOT_FOUND);
    return collection;
  }

  createCollection(body: CreateCatalogEntry) {
    if (body.slug === PERSONAL_COLLECTION_SLUG) throw new ApiError('VALIDATION_FAILED', SLUG_RESERVED);
    return this.repository.insertCollection(body);
  }

  async patchCollection(id: string, body: PatchCatalogEntry) {
    if (body.slug === PERSONAL_COLLECTION_SLUG) throw new ApiError('VALIDATION_FAILED', SLUG_RESERVED);
    const row = await this.repository.updateCollection(id, body);
    if (!row) throw new ApiError('NOT_FOUND', COLLECTION_NOT_FOUND);
    return row;
  }

  async deleteCollection(id: string) {
    const state = await this.repository.findCollectionDeletionState(id);
    if (!state) throw new ApiError('NOT_FOUND', COLLECTION_NOT_FOUND);
    if (state.status !== CONTENT_STATUS.DRAFT) throw new ApiError('CONTENT_LOCKED', DRAFT_DELETE_ONLY);
    if (state.topics > 0) throw new ApiError('CONTENT_LOCKED', 'Delete its topics first');
    await this.repository.deleteCollection(id);
  }

  async putCollectionLocale(collectionId: string, locale: string, body: CatalogLocale) {
    await this.assertCollection(collectionId);
    await this.repository.upsertCollectionLocale(collectionId, locale, body);
    return { collectionId, locale, ...body };
  }

  async deleteCollectionLocale(collectionId: string, locale: string) {
    await this.assertCollection(collectionId);
    if (!(await this.repository.deleteCollectionLocale(collectionId, locale))) throw new ApiError('NOT_FOUND', LOCALE_NOT_FOUND);
  }

  async createTopic(collectionId: string, body: CreateCatalogEntry) {
    await this.assertCollection(collectionId);
    return this.repository.insertTopic(collectionId, body);
  }

  async getTopic(id: string) {
    const topic = await this.repository.findTopic(id);
    if (!topic) throw new ApiError('NOT_FOUND', TOPIC_NOT_FOUND);
    return topic;
  }

  async patchTopic(id: string, body: PatchCatalogEntry) {
    const row = await this.repository.updateTopic(id, body);
    if (!row) throw new ApiError('NOT_FOUND', TOPIC_NOT_FOUND);
    return row;
  }

  async deleteTopic(id: string) {
    const status = await this.repository.topicStatus(id);
    if (!status) throw new ApiError('NOT_FOUND', TOPIC_NOT_FOUND);
    if (status !== CONTENT_STATUS.DRAFT) throw new ApiError('CONTENT_LOCKED', DRAFT_DELETE_ONLY);
    await this.repository.deleteTopic(id);
  }

  async putTopicLocale(topicId: string, locale: string, body: CatalogLocale) {
    await this.assertCatalogTopic(topicId);
    await this.repository.upsertTopicLocale(topicId, locale, body);
    return { topicId, locale, ...body };
  }

  async deleteTopicLocale(topicId: string, locale: string) {
    await this.assertCatalogTopic(topicId);
    if (!(await this.repository.deleteTopicLocale(topicId, locale))) throw new ApiError('NOT_FOUND', LOCALE_NOT_FOUND);
  }

  async listTopicMeanings(topicId: string, locale = DEFAULT_LOCALE) {
    await this.assertCatalogTopic(topicId);
    return { items: await this.repository.listTopicMeanings(topicId, locale) };
  }

  // Appends in the given order. Only shared meanings that are live can enter the catalog.
  async addTopicMeanings(topicId: string, meaningIds: string[]) {
    await this.assertCatalogTopic(topicId);
    if ((await this.repository.countEligibleMeanings(meaningIds)) !== meaningIds.length) {
      throw new ApiError('CONTENT_UNAVAILABLE', 'Every meaning must be shared and published');
    }
    return { added: await this.repository.appendTopicMeanings(topicId, meaningIds) };
  }

  async removeTopicMeaning(topicId: string, meaningId: string) {
    await this.assertCatalogTopic(topicId);
    if (!(await this.repository.removeTopicMeaning(topicId, meaningId))) throw new ApiError('NOT_FOUND', 'Meaning is not in this topic');
  }

  async reorderTopicMeanings(topicId: string, meaningIds: string[]) {
    await this.assertCatalogTopic(topicId);
    if (!(await this.repository.reorderTopicMeanings(topicId, meaningIds))) {
      throw new ApiError('VALIDATION_FAILED', 'meaningIds must list every meaning of the topic exactly once');
    }
    return { topicId, meaningIds };
  }

  private async assertCollection(id: string) {
    if (!(await this.repository.collectionExists(id))) throw new ApiError('NOT_FOUND', COLLECTION_NOT_FOUND);
  }

  private async assertCatalogTopic(id: string) {
    if (!(await this.repository.topicStatus(id))) throw new ApiError('NOT_FOUND', TOPIC_NOT_FOUND);
  }
}
