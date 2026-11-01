import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, getTableColumns, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { Clock } from '../../common/clock';
import { CONTENT_STATUS } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { DB, Db } from '../../db/db';
import { appUsers, collections, topics, userActiveTopics, userLearningScope, userSettings } from '../../db/schema';
import { levelsSchema, scopeSchema, settingsSchema } from './identity.schemas';

const { userId: _userId, ...settingsView } = getTableColumns(userSettings);

@Injectable()
export class IdentityService {
  constructor(@Inject(DB) private readonly db: Db, private readonly clock: Clock) {}

  async getMe(userId: string) {
    const user = await this.db.query.appUsers.findFirst({
      where: eq(appUsers.id, userId),
      columns: { id: true, proficiencyLevel: true },
      with: {
        settings: { columns: { userId: false } },
        learningScope: { columns: { collectionId: true } },
        // The personal topic is not a catalog choice; clients echo this list back to setScope.
        activeTopics: { columns: { topicId: true }, where: (t) => notInArray(t.topicId, this.personalTopics(userId)) },
      },
    });
    if (!user) throw new ApiError('NOT_FOUND', 'User not found');
    const { learningScope, activeTopics, ...profile } = user;
    return {
      ...profile,
      scope: learningScope && { collectionId: learningScope.collectionId, topicIds: activeTopics.map((t) => t.topicId) },
    };
  }

  async setLevels(userId: string, body: z.infer<typeof levelsSchema>) {
    await this.db.update(appUsers).set({ proficiencyLevel: body.proficiencyLevel }).where(eq(appUsers.id, userId));
    return { proficiencyLevel: body.proficiencyLevel };
  }

  async updateSettings(userId: string, body: z.infer<typeof settingsSchema>) {
    const [row] = await this.db
      .update(userSettings)
      .set({ ...body, updatedAt: this.clock.now() })
      .where(eq(userSettings.userId, userId))
      .returning(settingsView);
    if (!row) throw new ApiError('NOT_FOUND', 'Settings not found');
    return row;
  }

  async setScope(userId: string, { collectionId, topicIds }: z.infer<typeof scopeSchema>) {
    const ids = [...new Set(topicIds)];
    const [{ valid }] = await this.db
      .select({ valid: count() })
      .from(topics)
      .innerJoin(collections, eq(collections.id, topics.collectionId))
      .where(and(
        inArray(topics.id, ids),
        eq(topics.collectionId, collectionId),
        eq(topics.status, CONTENT_STATUS.PUBLISHED),
        eq(collections.status, CONTENT_STATUS.PUBLISHED),
      ));
    if (valid !== ids.length) throw new ApiError('VALIDATION_FAILED', 'Topics must be published and belong to the Collection');

    const updatedAt = this.clock.now();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(userLearningScope)
        .values({ userId, collectionId, updatedAt })
        .onConflictDoUpdate({ target: userLearningScope.userId, set: { collectionId, updatedAt } });
      // Changing the catalog scope must not drop the words the learner added.
      await tx.delete(userActiveTopics).where(and(eq(userActiveTopics.userId, userId), notInArray(userActiveTopics.topicId, this.personalTopics(userId))));
      await tx.insert(userActiveTopics).values(ids.map((topicId) => ({ userId, topicId })));
    });
    return { collectionId, topicIds: ids };
  }

  private personalTopics(userId: string) {
    return this.db.select({ id: topics.id }).from(topics).where(eq(topics.ownerUserId, userId));
  }
}
