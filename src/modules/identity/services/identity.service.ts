import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../../common/clock';
import { ApiError } from '../../../common/http/api-error';
import { IdentityRepository } from '../repositories/identity.repository';
import { levelsSchema, scopeSchema, settingsSchema } from '../dto/identity.schemas';

@Injectable()
export class IdentityService {
  constructor(private readonly repository: IdentityRepository, private readonly clock: Clock) {}

  async getMe(userId: string) {
    const user = await this.repository.findProfile(userId);
    if (!user) throw new ApiError('NOT_FOUND', 'User not found');
    const { learningScope, activeTopics, ...profile } = user;
    return {
      ...profile,
      scope: learningScope && { collectionId: learningScope.collectionId, topicIds: activeTopics.map((t) => t.topicId) },
    };
  }

  async setLevels(userId: string, body: z.infer<typeof levelsSchema>) {
    await this.repository.updateProficiency(userId, body.proficiencyLevel);
    return { proficiencyLevel: body.proficiencyLevel };
  }

  async updateSettings(userId: string, body: z.infer<typeof settingsSchema>) {
    const row = await this.repository.updateSettings(userId, { ...body, updatedAt: this.clock.now() });
    if (!row) throw new ApiError('NOT_FOUND', 'Settings not found');
    return row;
  }

  async setScope(userId: string, { collectionId, topicIds }: z.infer<typeof scopeSchema>) {
    const ids = [...new Set(topicIds)];
    if ((await this.repository.countPublishedTopics(collectionId, ids)) !== ids.length) {
      throw new ApiError('VALIDATION_FAILED', 'Topics must be published and belong to the Collection');
    }
    await this.repository.replaceScope(userId, collectionId, ids, this.clock.now());
    return { collectionId, topicIds: ids };
  }
}
