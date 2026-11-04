import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiError } from '../../../common/http/api-error';
import { CatalogRepository } from '../repositories/catalog.repository';

@Controller('v1/catalog')
export class CatalogController {
  constructor(private readonly repository: CatalogRepository) {}

  @Get('collections')
  async collections(@CurrentUser() user: AuthUser) {
    const locale = await this.repository.uiLocale(user.id);
    if (!locale) throw new ApiError('NOT_FOUND', 'Settings not found');
    const rows = await this.repository.listPublished(locale);
    const view = <T extends { id: string; slug: string; title: string; localizations: { title: string; description: string | null }[] }>(row: T) => ({
      id: row.id,
      slug: row.slug,
      title: row.localizations[0]?.title ?? row.title,
      description: row.localizations[0]?.description ?? null,
    });
    return { collections: rows.map((c) => ({ ...view(c), topics: c.topics.map(view) })) };
  }
}
