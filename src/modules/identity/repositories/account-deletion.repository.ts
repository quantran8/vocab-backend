import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, notExists, or } from 'drizzle-orm';
import { DB, Db } from '../../../db/db';
import {
  activeMeaningPublications, appUsers, checkpointChallengeMeanings, checkpointChallenges, deletedIdentities, exampleLocalizations,
  learningSessions, lexicalDrafts, meaningExamples, meaningLocalizations, meaningPublications, meanings, memoryObservations,
  skillEvidence, speechAssessmentReceipts, topicLocalizations, topicMeanings, topics, userActiveTopics, userMeaningOverrides,
  userMeaningProgress,
} from '../../../db/schema';

@Injectable()
export class AccountDeletionRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // beforeCommit runs last, inside the transaction: if it throws nothing is lost and the client can retry.
  async deleteAccount(userId: string, subject: string, deletedAt: Date, beforeCommit: () => Promise<void>) {
    await this.db.transaction(async (tx) => {
      // Waits for an in-flight commit and blocks new ones, whose rows would otherwise stop the final delete.
      await tx.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.id, userId)).for('update');

      const sessions = tx.select({ id: learningSessions.id }).from(learningSessions).where(eq(learningSessions.userId, userId));
      const challenges = tx.select({ id: checkpointChallenges.id }).from(checkpointChallenges).where(eq(checkpointChallenges.userId, userId));
      await tx.delete(skillEvidence).where(eq(skillEvidence.userId, userId));
      await tx.delete(memoryObservations).where(eq(memoryObservations.userId, userId));
      await tx.delete(checkpointChallengeMeanings).where(inArray(checkpointChallengeMeanings.challengeId, challenges));
      await tx.delete(checkpointChallenges).where(eq(checkpointChallenges.userId, userId));
      await tx.delete(userMeaningProgress).where(eq(userMeaningProgress.userId, userId));
      await tx.delete(speechAssessmentReceipts).where(inArray(speechAssessmentReceipts.sessionId, sessions));
      await tx.delete(learningSessions).where(eq(learningSessions.userId, userId));
      await tx.delete(userMeaningOverrides).where(eq(userMeaningOverrides.userId, userId));
      await tx.delete(userActiveTopics).where(eq(userActiveTopics.userId, userId));

      // Private content goes with its author. A meaning an admin approved has no owner any more and stays shared.
      const personalTopics = tx.select({ id: topics.id }).from(topics).where(eq(topics.ownerUserId, userId));
      const privateMeanings = tx.select({ id: meanings.id }).from(meanings).where(eq(meanings.ownerUserId, userId));
      const privateExamples = tx.select({ id: meaningExamples.id }).from(meaningExamples).where(inArray(meaningExamples.meaningId, privateMeanings));
      await tx.delete(topicMeanings).where(or(inArray(topicMeanings.topicId, personalTopics), inArray(topicMeanings.meaningId, privateMeanings)));
      await tx.delete(topicLocalizations).where(inArray(topicLocalizations.topicId, personalTopics));
      await tx.delete(topics).where(eq(topics.ownerUserId, userId));
      await tx.delete(lexicalDrafts).where(inArray(lexicalDrafts.meaningId, privateMeanings));
      await tx.delete(exampleLocalizations).where(inArray(exampleLocalizations.exampleId, privateExamples));
      await tx.delete(meaningExamples).where(inArray(meaningExamples.meaningId, privateMeanings));
      await tx.delete(meaningLocalizations).where(inArray(meaningLocalizations.meaningId, privateMeanings));
      await tx.delete(activeMeaningPublications).where(inArray(activeMeaningPublications.meaningId, privateMeanings));
      await tx.delete(meaningPublications).where(inArray(meaningPublications.meaningId, privateMeanings));
      await tx.delete(meanings).where(eq(meanings.ownerUserId, userId));
      await tx.delete(lexicalDrafts).where(and(
        eq(lexicalDrafts.ownerUserId, userId),
        notExists(tx.select({ id: meanings.id }).from(meanings).where(eq(meanings.lexicalDraftId, lexicalDrafts.id))),
      ));

      // Settings, scope and usage cascade; the shared pool only loses its reference to this user.
      await tx.delete(appUsers).where(eq(appUsers.id, userId));
      await tx.insert(deletedIdentities).values({ identitySubject: subject, deletedAt }).onConflictDoNothing();
      await beforeCommit();
    });
  }
}
