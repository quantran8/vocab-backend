import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { CONTENT_STATUS } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { userSettings } from '../../../db/schema';

@Injectable()
export class CatalogRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async uiLocale(userId: string) {
    const settings = await this.db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId), columns: { uiLocale: true } });
    return settings?.uiLocale;
  }

  listPublished(locale: string) {
    return this.db.query.collections.findMany({
      where: (c) => eq(c.status, CONTENT_STATUS.PUBLISHED),
      orderBy: (c) => asc(c.slug),
      columns: { id: true, slug: true, title: true },
      with: {
        localizations: {
          where: (l) => eq(l.locale, locale),
          columns: { title: true, description: true },
        },
        topics: {
          where: (t) => eq(t.status, CONTENT_STATUS.PUBLISHED),
          orderBy: (t) => asc(t.slug),
          columns: { id: true, slug: true, title: true },
          with: {
            localizations: {
              where: (l) => eq(l.locale, locale),
              columns: { title: true, description: true },
            },
          },
        },
      },
    });
  }
}
