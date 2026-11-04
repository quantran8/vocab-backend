import { Injectable, Logger } from '@nestjs/common';
import { AuthUser } from '../../../common/auth/auth.decorators';
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

  // Self-change is refused so the last admin cannot lock everyone out. No audit table exists yet, so the log is the trail.
  async setRole(actor: AuthUser, targetId: string, role: string | null) {
    if (actor.subject === targetId) throw new ApiError('FORBIDDEN', 'You cannot change your own role');
    await this.auth.setRole(targetId, role);
    this.logger.log(`role changed: actor=${actor.subject} target=${targetId} role=${role ?? 'none'}`);
    return { id: targetId, role };
  }
}
