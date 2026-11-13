import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, getTableColumns, inArray, notInArray, sql } from 'drizzle-orm';
import { CONTENT_STATUS } from '../../../common/constants/domain';
import { DB, Db, Tx } from '../../../db/db';
import { syncListedSql } from '../../ranking/repositories/listing.sql';
import { appUsers, collections, topics, userActiveTopics, userLearningScope, userSettings } from '../../../db/schema';

const { userId: _userId, ...settingsView } = getTableColumns(userSettings);

type SettingsPatch = Partial<Omit<typeof userSettings.$inferInsert, 'userId'>>;

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  findProfile(userId: string) {
    return this.db.query.appUsers.findFirst({
      where: eq(appUsers.id, userId),
      columns: { id: true, proficiencyLevel: true, username: true, avatarKey: true, usernameGenerated: true, usernameChangedAt: true, rankingIntroSeen: true },
      with: {
        effortTotals: { columns: { lifetimeLp: true, lifetimeActiveDays: true, tierLevel: true } },
        settings: { columns: { userId: false } },
        learningScope: { columns: { collectionId: true } },
        reviewPauses: { columns: { collectionId: true, pausedAt: true }, orderBy: (p) => p.pausedAt },
        // The personal topic is not a catalog choice; clients echo this list back to setScope.
        activeTopics: { columns: { topicId: true }, where: (t) => notInArray(t.topicId, this.personalTopics(userId)) },
      },
    });
  }

  async updateProficiency(userId: string, proficiencyLevel: typeof appUsers.$inferInsert['proficiencyLevel']) {
    await this.db.update(appUsers).set({ proficiencyLevel }).where(eq(appUsers.id, userId));
  }

  // A new goal cancels the temporary override (§7.4); SET reads the old goal.
  async updateSettings(userId: string, patch: SettingsPatch) {
    const goal = patch.dailyNewWordGoal;
    const keepIfSameGoal = <T>(column: T) => sql`CASE WHEN ${userSettings.dailyNewWordGoal} = ${goal}::smallint THEN ${column} END`;
    const cancel = goal === undefined ? {} : {
      newWordOverride: keepIfSameGoal(userSettings.newWordOverride),
      newWordOverrideMode: keepIfSameGoal(userSettings.newWordOverrideMode),
      newWordOverrideUntil: keepIfSameGoal(userSettings.newWordOverrideUntil),
    };
    const update = (db: Db | Tx) => db.update(userSettings).set({ ...patch, ...cancel }).where(eq(userSettings.userId, userId)).returning(settingsView);
    if (patch.leaderboardVisible === undefined) return (await update(this.db))[0];
    return this.db.transaction(async (tx) => {
      const [row] = await update(tx);
      await tx.execute(syncListedSql(userId));
      return row;
    });
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
