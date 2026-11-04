import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, getTableColumns, inArray, notInArray } from 'drizzle-orm';
import { CONTENT_STATUS } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { appUsers, collections, topics, userActiveTopics, userLearningScope, userSettings } from '../../../db/schema';

const { userId: _userId, ...settingsView } = getTableColumns(userSettings);

type SettingsPatch = Partial<Omit<typeof userSettings.$inferInsert, 'userId'>>;

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  findProfile(userId: string) {
    return this.db.query.appUsers.findFirst({
      where: eq(appUsers.id, userId),
      columns: { id: true, proficiencyLevel: true },
      with: {
        settings: { columns: { userId: false } },
        learningScope: { columns: { collectionId: true } },
        // The personal topic is not a catalog choice; clients echo this list back to setScope.
        activeTopics: { columns: { topicId: true }, where: (t) => notInArray(t.topicId, this.personalTopics(userId)) },
      },
    });
  }

  async updateProficiency(userId: string, proficiencyLevel: typeof appUsers.$inferInsert['proficiencyLevel']) {
    await this.db.update(appUsers).set({ proficiencyLevel }).where(eq(appUsers.id, userId));
  }

  async updateSettings(userId: string, patch: SettingsPatch) {
    const [row] = await this.db.update(userSettings).set(patch).where(eq(userSettings.userId, userId)).returning(settingsView);
    return row;
  }

  async countPublishedTopics(collectionId: string, topicIds: string[]) {
    const [{ valid }] = await this.db
      .select({ valid: count() })
      .from(topics)
      .innerJoin(collections, eq(collections.id, topics.collectionId))
      .where(and(
        inArray(topics.id, topicIds),
        eq(topics.collectionId, collectionId),
        eq(topics.status, CONTENT_STATUS.PUBLISHED),
        eq(collections.status, CONTENT_STATUS.PUBLISHED),
      ));
    return valid;
  }

  async replaceScope(userId: string, collectionId: string, topicIds: string[], updatedAt: Date) {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(userLearningScope)
        .values({ userId, collectionId, updatedAt })
        .onConflictDoUpdate({ target: userLearningScope.userId, set: { collectionId, updatedAt } });
      // Changing the catalog scope must not drop the words the learner added.
      await tx.delete(userActiveTopics).where(and(eq(userActiveTopics.userId, userId), notInArray(userActiveTopics.topicId, this.personalTopics(userId))));
      await tx.insert(userActiveTopics).values(topicIds.map((topicId) => ({ userId, topicId })));
    });
  }

  private personalTopics(userId: string) {
    return this.db.select({ id: topics.id }).from(topics).where(eq(topics.ownerUserId, userId));
  }
}
