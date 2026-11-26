import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';

export abstract class PubSubPushVerifier {
  /** Throws unless the `Authorization` header carries the push subscription's OIDC token. */
  abstract verify(authorization: string | undefined): Promise<void>;
}

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class GooglePubSubPushVerifier extends PubSubPushVerifier {
  protected keys: JWTVerifyGetKey | null = null;

  constructor(private readonly config: AppConfig) {
    super();
  }

  async verify(authorization: string | undefined) {
    const audience = this.config.playStorePushAudience;
    if (!audience) throw new ApiError('FORBIDDEN', 'Play notifications are not configured');
    if (!authorization?.startsWith(BEARER_PREFIX)) throw new ApiError('UNAUTHORIZED', 'Missing bearer token');
    this.keys ??= createRemoteJWKSet(new URL(GOOGLE_CERTS_URL));
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(authorization.slice(BEARER_PREFIX.length), this.keys, { issuer: GOOGLE_ISSUERS, audience }));
    } catch {
      throw new ApiError('UNAUTHORIZED', 'Invalid push token');
    }
    const expected = this.config.playStorePushServiceAccount;
    if (expected && (payload.email !== expected || payload.email_verified !== true)) throw new ApiError('FORBIDDEN', 'Unexpected push sender');
  }
}
