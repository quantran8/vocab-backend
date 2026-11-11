import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';
import { AuthProvider, ProviderSession, SignupResponse } from '../providers/auth.provider';
import { changePasswordSchema, credentialsSchema, idTokenSchema, loginSchema, recoverSchema, recoverVerifySchema } from '../dto/auth.schemas';

const toSession = (s: ProviderSession) => ({
  accessToken: s.access_token,
  refreshToken: s.refresh_token,
  expiresIn: s.expires_in,
  user: { id: s.user.id, email: s.user.email ?? null },
});
export type AuthSession = ReturnType<typeof toSession>;

const hasSession = (r: SignupResponse): r is ProviderSession => 'access_token' in r;

@Injectable()
export class AuthService {
  constructor(private readonly provider: AuthProvider, private readonly config: AppConfig) {}

  async signup({ email, password }: z.infer<typeof credentialsSchema>) {
    const result = await this.provider.signup(email, password);
    if (hasSession(result)) return { session: toSession(result), confirmationRequired: false };
    return { session: null, confirmationRequired: true };
  }

  async login({ email: login, password }: z.infer<typeof loginSchema>) {
    const { seedAdminUsername, seedAdminEmail } = this.config;
    const email = z.email().safeParse(login === seedAdminUsername ? seedAdminEmail : login);
    if (!email.success) throw new ApiError('VALIDATION_FAILED', 'email: Invalid email address');
    return toSession(await this.provider.password(email.data, password));
  }

  async google({ idToken, nonce }: z.infer<typeof idTokenSchema>) {
    return toSession(await this.provider.idToken('google', idToken, nonce));
  }

  async apple({ idToken, nonce }: z.infer<typeof idTokenSchema>) {
    return toSession(await this.provider.idToken('apple', idToken, nonce));
  }

  async recover({ email }: z.infer<typeof recoverSchema>) {
    await this.provider.recover(email);
    return { sent: true };
  }

  // Signs the learner in: the code proves they own the address.
  async recoverVerify({ email, code, password }: z.infer<typeof recoverVerifySchema>) {
    let session: ProviderSession;
    try {
      session = await this.provider.verifyRecovery(email, code);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH_PROVIDER_UNAVAILABLE') throw error;
      throw new ApiError('RESET_CODE_INVALID', 'Reset code is wrong or expired');
    }
    await this.provider.updatePassword(session.access_token, password);
    return toSession(session);
  }

  // Re-checks the current password so a borrowed unlocked phone can't take over the account.
  async changePassword(subject: string, { currentPassword, newPassword }: z.infer<typeof changePasswordSchema>) {
    const { email } = await this.provider.getUser(subject);
    if (!email) throw new ApiError('WRONG_PASSWORD', 'Account has no password');
    let session: ProviderSession;
    try {
      session = await this.provider.password(email, currentPassword);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHORIZED') throw new ApiError('WRONG_PASSWORD', 'Current password is wrong');
      throw error;
    }
    await this.provider.updatePassword(session.access_token, newPassword);
    return { changed: true };
  }

  async refresh(refreshToken: string) {
    return toSession(await this.provider.refresh(refreshToken));
  }
}
