import { Injectable } from '@nestjs/common';
import { ITEM_STATUS, Template, TEMPLATE_VARIANTS, Variant } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { curatedContentSchema } from '../../practice-resolver/curated';
import { AdminPracticeItemsRepository } from '../repositories/admin-practice-items.repository';
import { ListItems, PatchItem } from '../dto/admin.schemas';
import { AdminService } from './admin.service';

const DRAFT_ONLY = 'Only a draft can be changed; create a new revision with supersedesItemId';
const ITEM_NOT_FOUND = 'Practice item not found';

@Injectable()
export class AdminPracticeItemsService {
  constructor(private readonly repository: AdminPracticeItemsRepository, private readonly admin: AdminService) {}

  list(query: ListItems) {
    return this.repository.list(query);
  }

  async get(id: string) {
    const item = await this.repository.find(id);
    if (!item) throw new ApiError('NOT_FOUND', ITEM_NOT_FOUND);
    return item;
  }

  async patch(id: string, { targets, ...fields }: PatchItem) {
    const current = await this.repository.findShape(id);
    if (!current) throw new ApiError('NOT_FOUND', ITEM_NOT_FOUND);
    if (current.status !== ITEM_STATUS.DRAFT) throw new ApiError('CONTENT_LOCKED', DRAFT_ONLY);

    const template = (fields.template ?? current.template) as Template;
    const variant = (fields.variant ?? current.variant) as Variant;
    if (!TEMPLATE_VARIANTS[template].includes(variant)) throw new ApiError('TASK_DATA_INVALID', `Variant ${variant} is not valid for ${template}`);
    if (fields.sourceContent && !curatedContentSchema.safeParse(fields.sourceContent).success) throw new ApiError('TASK_DATA_INVALID', 'promptVariants missing');
    if (targets) await this.admin.assertAligned(targets);

    await this.repository.updateDraft(id, fields, targets);
    return { id };
  }

  async remove(id: string) {
    if ((await this.statusOf(id)) !== ITEM_STATUS.DRAFT) throw new ApiError('CONTENT_LOCKED', DRAFT_ONLY);
    await this.repository.removeDraft(id);
  }

  async retire(id: string) {
    if (await this.repository.retire(id)) return { id, status: ITEM_STATUS.RETIRED };
    await this.statusOf(id);
    throw new ApiError('CONTENT_LOCKED', 'Only a published item can be retired');
  }

  private async statusOf(id: string) {
    const status = await this.repository.statusOf(id);
    if (!status) throw new ApiError('NOT_FOUND', ITEM_NOT_FOUND);
    return status;
  }
}
