import { Injectable } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig, type ServiceAccount } from '../../../config/app-config';
import type { PlaySubscription } from '../domain/playstore';

export abstract class GooglePlayClient {
  /** The subscription behind a purchase token, or null when Google does not know it for this package. */
  abstract subscription(packageName: string, purchaseToken: string): Promise<PlaySubscription | null>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const ASSERTION_TTL_S = 3600;
// Fetch a new access token this long before the cached one expires.
const REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
// A token that is malformed, unknown or for another package.
const INVALID_TOKEN_STATUSES = new Set([400, 404, 410]);
const UNAUTHORIZED_STATUS = 401;

interface AccessToken {
  value: string;
  expiresAt: number;
}

/** Google Play Developer API with a service account (JWT bearer grant). Wall-clock time, not `Clock`: Google checks it. */
@Injectable()
export class GooglePlayApiClient extends GooglePlayClient {
  private cached: AccessToken | null = null;
  private pending: Promise<AccessToken> | null = null;

  constructor(private readonly config: AppConfig) {
    super();
  }

  async subscription(packageName: string, purchaseToken: string): Promise<PlaySubscription | null> {
    const account = this.config.playStoreServiceAccount;
    if (!account) throw new ApiError('PLAYSTORE_UNAVAILABLE', 'Google Play is not configured');
    const accessToken = await this.accessToken(account);
    const url = `${API_BASE}/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const response = await this.send(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (INVALID_TOKEN_STATUSES.has(response.status)) return null;
    if (response.status === UNAUTHORIZED_STATUS) this.cached = null;
    if (!response.ok) throw new ApiError('PLAYSTORE_UNAVAILABLE', `Google Play answered ${response.status}`);
    return (await response.json()) as PlaySubscription;
  }

  private async accessToken(account: ServiceAccount) {
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return this.cached.value;
    // Concurrent callers share one exchange.
    this.pending ??= this.exchange(account).finally(() => { this.pending = null; });
    this.cached = await this.pending;
    return this.cached.value;
  }

  private async exchange(account: ServiceAccount): Promise<AccessToken> {
    let assertion: string;
    try {
      const key = await importPKCS8(account.privateKey, 'RS256');
      assertion = await new SignJWT({ scope: SCOPE })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(account.privateKeyId && { kid: account.privateKeyId }) })
        .setIssuer(account.clientEmail).setAudience(TOKEN_URL).setIssuedAt().setExpirationTime(`${ASSERTION_TTL_S}s`)
        .sign(key);
    } catch {
      throw new ApiError('PLAYSTORE_UNAVAILABLE', 'Bad Google Play service account key');
    }
    const response = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!response.ok) throw new ApiError('PLAYSTORE_UNAVAILABLE', `Google token exchange answered ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    return { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  }

  private async send(url: string, init: RequestInit) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new ApiError('PLAYSTORE_UNAVAILABLE', 'Google Play request failed');
    }
  }
}
