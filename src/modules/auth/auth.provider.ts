import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { AppConfig } from '../../config/app-config';

const REQUEST_TIMEOUT_MS = 10_000;
const SERVER_ERROR_MIN = 500;
const TOO_MANY_REQUESTS = 429;
const NOT_FOUND = 404;
// GoTrue error_code values that mean "wrong credentials" or "token no longer usable".
const CREDENTIAL_ERRORS = new Set([
  'invalid_credentials', 'invalid_grant', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'session_not_found',
]);
const DUPLICATE_ERRORS = new Set(['user_already_exists', 'email_exists']);

export interface ProviderSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: ProviderUser;
}

export interface ProviderUser {
  id: string;
  email?: string;
}

// Signup with email confirmation on returns the user without a session.
export type SignupResponse = ProviderUser | ProviderSession;

interface ProviderError {
  error_code?: string;
  code?: string | number;
  msg?: string;
  error_description?: string;
}

@Injectable()
export class AuthProvider {
  constructor(private readonly config: AppConfig) {}

  signup(email: string, password: string) {
    return this.call<SignupResponse>('signup', { email, password });
  }

  password(email: string, password: string) {
    return this.call<ProviderSession>('token?grant_type=password', { email, password });
  }

  googleIdToken(idToken: string, nonce?: string) {
    return this.call<ProviderSession>('token?grant_type=id_token', { provider: 'google', id_token: idToken, nonce });
  }

  refresh(refreshToken: string) {
    return this.call<ProviderSession>('token?grant_type=refresh_token', { refresh_token: refreshToken });
  }

  // A rejected service key must not read as UNAUTHORIZED: that would sign the learner out.
  async deleteUser(subject: string) {
    const secret = this.config.supabaseServiceRoleKey;
    if (!secret) throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'Auth admin is not configured');
    let response: Response;
    try {
      response = await fetch(`${this.config.jwtIssuer}/admin/users/${encodeURIComponent(subject)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${secret}`, apikey: secret },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'Auth provider request failed');
    }
    // Already gone: an earlier attempt removed the identity but failed to commit.
    if (!response.ok && response.status !== NOT_FOUND) throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', `Auth admin returned ${response.status}`);
  }

  private async call<T>(path: string, body: object): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.jwtIssuer}/${path}`, {
        method: 'POST',
        headers: { apikey: this.config.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'Auth provider request failed');
    }
    if (response.ok) return (await response.json()) as T;
    throw await this.toApiError(response);
  }

  private async toApiError(response: Response) {
    if (response.status >= SERVER_ERROR_MIN || response.status === TOO_MANY_REQUESTS) {
      return new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'Auth provider is unavailable');
    }
    const error = (await response.json().catch(() => ({}))) as ProviderError;
    const code = error.error_code ?? String(error.code ?? '');
    if (DUPLICATE_ERRORS.has(code)) return new ApiError('EMAIL_ALREADY_REGISTERED', 'Email is already registered');
    if (CREDENTIAL_ERRORS.has(code)) return new ApiError('UNAUTHORIZED', 'Invalid credentials');
    return new ApiError('VALIDATION_FAILED', error.msg ?? error.error_description ?? 'Request rejected by auth provider');
  }
}
