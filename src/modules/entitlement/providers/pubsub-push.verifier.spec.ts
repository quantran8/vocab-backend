import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ApiError } from '../../../common/http/api-error';
import type { AppConfig } from '../../../config/app-config';
import { GooglePubSubPushVerifier } from './pubsub-push.verifier';

const AUDIENCE = 'https://api.example.test/v1/playstore/notifications';
const SENDER = 'rtdn-push@project.iam.gserviceaccount.com';

describe('GooglePubSubPushVerifier', () => {
  let sign: (claims: object, issuer?: string) => Promise<string>;
  let keys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] });
    sign = (claims, issuer = 'https://accounts.google.com') => new SignJWT({ ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(issuer).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  });

  const verifier = (config: Partial<AppConfig>) => {
    const v = new GooglePubSubPushVerifier(config as AppConfig);
    (v as unknown as { keys: typeof keys }).keys = keys;
    return v;
  };
  const codeOf = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: ApiError) => e.code);

  it('accepts Google-issued tokens for our audience from the expected sender', async () => {
    const v = verifier({ playStorePushAudience: AUDIENCE, playStorePushServiceAccount: SENDER });
    expect(await codeOf(v.verify(`Bearer ${await sign({ email: SENDER, email_verified: true })}`))).toBe('ok');
    expect(await codeOf(v.verify(`Bearer ${await sign({ email: 'other@x.iam.gserviceaccount.com', email_verified: true })}`))).toBe('FORBIDDEN');
    expect(await codeOf(v.verify(`Bearer ${await sign({ email: SENDER }, 'https://evil.example')}`))).toBe('UNAUTHORIZED');
    expect(await codeOf(v.verify(undefined))).toBe('UNAUTHORIZED');
  });

  it('refuses every push while no audience is configured', async () => {
    expect(await codeOf(verifier({}).verify(`Bearer ${await sign({})}`))).toBe('FORBIDDEN');
  });
});
