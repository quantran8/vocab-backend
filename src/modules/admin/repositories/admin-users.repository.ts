import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DB, Db } from '../../../db/db';
import { appUsers } from '../../../db/schema';

@Injectable()
export class AdminUsersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  findProfiles(identitySubjects: string[]) {
    return this.db
      .select({ id: appUsers.id, identitySubject: appUsers.identitySubject, proficiencyLevel: appUsers.proficiencyLevel })
      .from(appUsers)
      .where(inArray(appUsers.identitySubject, identitySubjects));
  }
}
