import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';
import { currentEntitlement, freeRemaining, normalizeCode, planView, type PlanView } from '../domain/entitlement';
import { EntitlementRepository, type NewRedeemCode } from '../repositories/entitlement.repository';

/** The server decides who is Premium; every limit below reads this, never the client. */
@Injectable()
export class EntitlementService {
  constructor(private readonly repository: EntitlementRepository, private readonly config: AppConfig, private readonly clock: Clock) {}

  async plan(userId: string, now = this.clock.now()): Promise<PlanView> {
    const rows = await this.repository.entitlements(userId);
    const enabled = this.config.freemiumEnabled;
    // The count is only read when the free tier applies.
    const newWordsUsed = enabled && !currentEntitlement(rows, now) ? await this.repository.learnedCount(userId) : 0;
    return planView(rows, now, { enabled, maxTopics: this.config.freeMaxTopics, maxNewWords: this.config.freeMaxNewWords, newWordsUsed });
  }

  /** New words the free tier still allows this learner, or null when nothing limits them. */
  async freeRemaining(userId: string, now?: Date) {
    return freeRemaining(await this.plan(userId, now));
  }

  /** Server switches the app follows. Ads only ever apply to a learner the free plan limits (`plan.limits`). */
  features() {
    return {
      freemiumEnabled: this.config.freemiumEnabled,
      redeemEnabled: this.config.redeemEnabled,
      adEverySessions: this.config.freemiumEnabled ? this.config.adEverySessions : 0,
    };
  }

  /** The free plan keeps the first Collection chosen and caps its topics. */
  async assertScope(userId: string, collectionId: string, topicCount: number) {
    const [{ limits }, current] = await Promise.all([this.plan(userId), this.repository.scopeCollectionId(userId)]);
    if (!limits) return;
    if (current && current !== collectionId) throw new ApiError('FREE_COLLECTION_LOCKED', 'The free plan keeps the first Collection chosen', { collectionId: current });
    if (topicCount > limits.maxTopics) {
      throw new ApiError('FREE_TOPIC_LIMIT', `The free plan allows ${limits.maxTopics} topics`, { maxTopics: limits.maxTopics });
    }
  }

  async assertPremium(userId: string) {
    if ((await this.plan(userId)).limits) throw new ApiError('PREMIUM_REQUIRED');
  }

  async redeem(userId: string, code: string) {
    if (!this.config.redeemEnabled) throw new ApiError('NOT_FOUND');
    const now = this.clock.now();
    await this.repository.redeem(userId, normalizeCode(code), now);
    return this.plan(userId, now);
  }

  createCode(code: NewRedeemCode) {
    return this.repository.createCode({ ...code, code: normalizeCode(code.code) });
  }

  listCodes(page: number, perPage: number) {
    return this.repository.listCodes(perPage, (page - 1) * perPage);
  }

  disableCode(code: string) {
    return this.repository.disableCode(normalizeCode(code), this.clock.now());
  }
}
