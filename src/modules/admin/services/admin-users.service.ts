import { Injectable, Logger } from '@nestjs/common';
import { AuthUser } from '../../../common/auth/auth.decorators';
import { ADMIN_ROLE } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { AuthProvider } from '../../auth/providers/auth.provider';
import { AdminUsersRepository } from '../repositories/admin-users.repository';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(private readonly repository: AdminUsersRepository, private readonly auth: AuthProvider) {}

  async list(page: number, perPage: number) {
    const { users, total } = await this.auth.listUsers(page, perPage);
    const profiles = await this.repository.findProfiles(users.map((u) => u.id));
    const bySubject = new Map(profiles.map((p) => [p.identitySubject, p]));
    return {
      total,
      items: users.map((user) => ({
        id: user.id,
        email: user.email ?? null,
        role: user.app_metadata?.role ?? null,
        createdAt: user.created_at ?? null,
        lastSignInAt: user.last_sign_in_at ?? null,
        appUserId: bySubject.get(user.id)?.id ?? null,
        proficiencyLevel: bySubject.get(user.id)?.proficiencyLevel ?? null,
      })),
    };
  }

  // The admin role exists only on the seeded account, so it can be neither granted nor changed here. No audit table yet, so the log is the trail.
  async setRole(actor: AuthUser, targetId: string, role: string | null) {
    const target = await this.auth.getUser(targetId);
    if (target.app_metadata?.role === ADMIN_ROLE.ADMIN) throw new ApiError('FORBIDDEN', 'The admin account cannot be changed');
    await this.auth.setRole(targetId, role);
    this.logger.log(`role changed: actor=${actor.subject} target=${targetId} role=${role ?? 'none'}`);
    return { id: targetId, role };
  }
}
