import { Injectable, Logger } from '@nestjs/common';
import { AuthUser } from '../../../common/auth/auth.decorators';
import { Clock } from '../../../common/clock';
import { REPORT_STATUS, ReportResolution } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { RankingRepository } from '../../ranking/repositories/ranking.repository';
import { withGeneratedUsername } from '../../ranking/repositories/username-collision';

// User ids here are app_user ids (appUserId in GET /admin/users), not auth provider ids.
@Injectable()
export class AdminRankingService {
  private readonly logger = new Logger(AdminRankingService.name);

  constructor(private readonly repository: RankingRepository, private readonly clock: Clock) {}

  async listReports(status: string, page: number, perPage: number) {
    return { items: await this.repository.listReports(status === REPORT_STATUS.RESOLVED, page, perPage) };
  }

  // Resolving only records the decision; the reset and eligibility endpoints carry it out.
  async resolveReport(actor: AuthUser, id: string, resolution: ReportResolution) {
    const row = await this.repository.resolveReport(id, actor.id, resolution, this.clock.now());
    if (row) return row;
    if (!(await this.repository.reportExists(id))) throw new ApiError('NOT_FOUND', 'Report not found');
    throw new ApiError('CONTENT_LOCKED', 'Report already resolved');
  }

  async resetUsername(actor: AuthUser, userId: string) {
    const row = await withGeneratedUsername((username) => this.repository.resetUsername(userId, username));
    if (!row) throw new ApiError('NOT_FOUND', 'User not found');
    this.logger.log(`username reset: actor=${actor.id} target=${userId}`);
    return row;
  }

  async setEligibility(actor: AuthUser, userId: string, eligible: boolean, reason: string) {
    const row = await this.repository.setEligibility({ userId, actorId: actor.id, eligible, reason, now: this.clock.now() });
    if (!row) throw new ApiError('NOT_FOUND', 'User not found');
    return row;
  }
}
