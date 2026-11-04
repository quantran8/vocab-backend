import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DB, Db } from '../../db/db';

@Injectable()
export class UserProvisioningRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // One statement: creates user + settings on first sight, otherwise only reads the id. A deleted identity gets neither.
  async provision(subject: string) {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      WITH existing AS (
        SELECT id FROM app_user WHERE identity_subject = ${subject}
      ), inserted AS (
        INSERT INTO app_user (id, identity_subject)
        SELECT ${uuidv7()}::uuid, ${subject}::text
        WHERE NOT EXISTS (SELECT 1 FROM existing)
          AND NOT EXISTS (SELECT 1 FROM deleted_identities WHERE identity_subject = ${subject})
        ON CONFLICT (identity_subject) DO UPDATE SET identity_subject = EXCLUDED.identity_subject
        RETURNING id
      ), settings AS (
        INSERT INTO user_settings (user_id) SELECT id FROM inserted
        ON CONFLICT (user_id) DO NOTHING
      )
      SELECT id FROM existing UNION ALL SELECT id FROM inserted`);
    return rows[0]?.id;
  }
}
