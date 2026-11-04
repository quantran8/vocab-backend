import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';

const REQUEST_TIMEOUT_MS = 10_000;
const SERVER_ERROR_MIN = 500;
const TOO_MANY_REQUESTS = 429;
const NOT_FOUND = 404;
const TOTAL_COUNT_HEADER = 'x-total-count';
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

export interface ProviderAdminUser extends ProviderUser {
  app_metadata?: { role?: string };
  created_at?: string;
  last_sign_in_at?: string | null;
}

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

  async listUsers(page: number, perPage: number) {
    const response = await this.adminCall(`admin/users?page=${page}&per_page=${perPage}`, 'GET');
    const { users } = (await response.json()) as { users: ProviderAdminUser[] };
    return { users, total: Number(response.headers.get(TOTAL_COUNT_HEADER) ?? users.length) };
  }

  // GoTrue merges app_metadata, and a null value removes the key.
  async setRole(userId: string, role: string | null) {
    await this.adminCall(`admin/users/${encodeURIComponent(userId)}`, 'PUT', { app_metadata: { role } });
  }

  async deleteUser(subject: string) {
    try {
      await this.adminCall(`admin/users/${encodeURIComponent(subject)}`, 'DELETE');
    } catch (error) {
      // Already gone: an earlier attempt removed the identity but failed to commit.
      if (!(error instanceof ApiError && error.code === 'NOT_FOUND')) throw error;
    }
  }

  // A rejected service key must not read as UNAUTHORIZED: that would sign the learner out.
  private async adminCall(path: string, method: string, body?: object) {
    const secret = this.config.supabaseServiceRoleKey;
    if (!secret) throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'SUPABASE_SERVICE_ROLE_KEY is not configured');
    let response: Response;
    try {
      response = await fetch(`${this.config.jwtIssuer}/${path}`, {
        method,
        headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        ...(body && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'Auth provider request failed');
    }
    if (response.ok) return response;
    if (response.status === NOT_FOUND) throw new ApiError('NOT_FOUND', 'User not found');
    throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'Auth provider rejected the admin request');
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
