import { Controller, Get, Inject } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { CONTENT_STATUS } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { DB, Db } from '../../db/db';
import { userSettings } from '../../db/schema';

@Controller('v1/catalog')
export class CatalogController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('collections')
  async collections(@CurrentUser() user: AuthUser) {
    const settings = await this.db.query.userSettings.findFirst({
      where: eq(userSettings.userId, user.id),
      columns: { uiLocale: true },
    });
    if (!settings) throw new ApiError('NOT_FOUND', 'Settings not found');
    const locale = settings.uiLocale;

    const rows = await this.db.query.collections.findMany({
      where: (c) => eq(c.status, CONTENT_STATUS.published),
      orderBy: (c) => asc(c.slug),
      columns: { id: true, slug: true, title: true },
      with: {
        localizations: {
          where: (l) => eq(l.locale, locale),
          columns: { title: true, description: true },
        },
        topics: {
          where: (t) => eq(t.status, CONTENT_STATUS.published),
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
    const view = <T extends { id: string; slug: string; title: string; localizations: { title: string; description: string | null }[] }>(row: T) => ({
      id: row.id,
      slug: row.slug,
      title: row.localizations[0]?.title ?? row.title,
      description: row.localizations[0]?.description ?? null,
    });
    return { collections: rows.map((c) => ({ ...view(c), topics: c.topics.map(view) })) };
  }
}
