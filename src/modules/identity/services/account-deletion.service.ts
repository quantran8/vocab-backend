import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../../common/auth/auth.decorators';
import { UserIdCache } from '../../../common/auth/user-id-cache';
import { Clock } from '../../../common/clock';
import { AuthProvider } from '../../auth/providers/auth.provider';
import { AccountDeletionRepository } from '../repositories/account-deletion.repository';

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly repository: AccountDeletionRepository,
    private readonly clock: Clock,
    private readonly provider: AuthProvider,
    private readonly userIds: UserIdCache,
  ) {}

  // The identity goes last, inside the transaction: if the provider fails nothing is lost and the client can retry.
  async deleteAccount({ id: userId, subject }: AuthUser) {
    await this.repository.deleteAccount(userId, subject, this.clock.now(), () => this.provider.deleteUser(subject));
    this.userIds.delete(subject);
    return { deleted: true };
  }
}
