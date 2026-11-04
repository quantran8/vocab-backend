import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';
import { AuthProvider, ProviderSession, SignupResponse } from '../providers/auth.provider';
import { credentialsSchema, googleSchema, loginSchema } from '../dto/auth.schemas';

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

  async google({ idToken, nonce }: z.infer<typeof googleSchema>) {
    return toSession(await this.provider.googleIdToken(idToken, nonce));
  }

  async refresh(refreshToken: string) {
    return toSession(await this.provider.refresh(refreshToken));
  }
}
