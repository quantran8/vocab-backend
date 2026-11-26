import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  PORT: z.coerce.number().int().positive().default(3000),
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  JWT_AUDIENCE: z.string().default('authenticated'),
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  LEXICAL_AI_MODEL: z.string().default('claude-opus-5-5'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().optional(),
  // Extra voices admins may pick for bulk audio, as "voiceId:Label,voiceId:Label". ELEVENLABS_VOICE_ID stays the default.
  ELEVENLABS_VOICE_OPTIONS: z.string().optional(),
  // Cloudflare R2 for generated audio; the public base is the bucket's custom domain or r2.dev URL.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^https$/ }).transform((url) => url.replace(/\/+$/, '')).optional()),
  ALLOW_PLACEHOLDER_AUDIO: z.stringbool().default(false),
  ENABLE_CRON: z.stringbool().default(true),
  // Leaderboard launch gate (Ranking spec R14); LP and Tier work either way.
  RANKING_ENABLED: z.stringbool().default(false),
  // Freemium launch gate: off, every learner has full access (old app builds keep working).
  FREEMIUM_ENABLED: z.stringbool().default(true),
  FREE_MAX_TOPICS: z.coerce.number().int().positive().default(5),
  FREE_MAX_NEW_WORDS: z.coerce.number().int().nonnegative().default(200),
  REDEEM_ENABLED: z.stringbool().default(false),
  // Free learners see an interstitial ad after every N finished sessions; 0 turns ads off.
  AD_EVERY_SESSIONS: z.coerce.number().int().nonnegative().default(3),
  APPSTORE_BUNDLE_ID: z.string().default('com.visiongroup.syll'),
  // Comma-separated product ids that grant Premium.
  APPSTORE_PRODUCT_IDS: z
    .string()
    .default('syll.premium.monthly,syll.premium.yearly')
    .transform((v) => v.split(',').map((p) => p.trim()).filter(Boolean)),
  // Accept unsigned Xcode StoreKit-testing transactions. Never on in production.
  APPSTORE_ALLOW_XCODE: z.stringbool().default(false),
  // SHA-256 fingerprints (hex, colons optional) of trusted root certificates; defaults to Apple Root CA - G3.
  APPSTORE_ROOT_FINGERPRINTS: z
    .string()
    .default('63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179')
    .transform((v) => v.split(',').map((f) => f.replace(/[^0-9a-f]/gi, '').toUpperCase()).filter(Boolean)),
  PLAYSTORE_PACKAGE_NAME: z.string().regex(/^[A-Za-z][\w.]*$/).default('com.syll'),
  // Comma-separated subscription product ids that grant Premium.
  PLAYSTORE_PRODUCT_IDS: z
    .string()
    .default('syll.premium.monthly,syll.premium.yearly')
    .transform((v) => v.split(',').map((p) => p.trim()).filter(Boolean)),
  // Service account key with access to the Play Developer API: the JSON file's content, raw or base64.
  PLAYSTORE_SERVICE_ACCOUNT_JSON: z.preprocess((v) => (v === '' ? undefined : v), z.string().transform(parseServiceAccount).optional()),
  // Audience set on the Pub/Sub push subscription for Real-time Developer Notifications; unset refuses every push.
  PLAYSTORE_PUSH_AUDIENCE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // The push subscription's service account; when set, a push token must carry this email.
  PLAYSTORE_PUSH_SERVICE_ACCOUNT: z.preprocess((v) => (v === '' ? undefined : v), z.email().optional()),
  // The Android app that `auth/apple/callback` sends Sign in with Apple's result back to.
  APPLE_ANDROID_PACKAGE: z.string().regex(/^[A-Za-z][\w.]*$/).default('com.syll'),
  SEED_ADMIN_USERNAME: z.string().trim().toLowerCase().min(1).optional(),
  SEED_ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  // Comma-separated browser origins allowed to call the API cross-origin; empty keeps CORS off.
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https?$/ }))),
  APP_VERSION: z.string().default('dev'),
  APP_COMMIT: z.string().default('unknown'),
});

@Injectable()
export class AppConfig {
  private readonly env = envSchema.parse(process.env);

  readonly databaseUrl = this.env.DATABASE_URL;
  readonly dbPoolSize = this.env.DB_POOL_SIZE;
  readonly port = this.env.PORT;
  readonly jwtIssuer = `${this.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  readonly jwksUrl = `${this.jwtIssuer}/.well-known/jwks.json`;
  readonly supabaseAnonKey = this.env.SUPABASE_ANON_KEY;
  readonly jwtAudience = this.env.JWT_AUDIENCE;
  readonly azureSpeechKey = this.env.AZURE_SPEECH_KEY;
  readonly azureSpeechRegion = this.env.AZURE_SPEECH_REGION;
  readonly supabaseUrl = this.env.SUPABASE_URL.replace(/\/$/, '');
  readonly supabaseServiceRoleKey = this.env.SUPABASE_SERVICE_ROLE_KEY;
  readonly anthropicApiKey = this.env.ANTHROPIC_API_KEY;
  readonly lexicalAiModel = this.env.LEXICAL_AI_MODEL;
  readonly elevenLabsApiKey = this.env.ELEVENLABS_API_KEY;
  readonly elevenLabsVoiceId = this.env.ELEVENLABS_VOICE_ID;
  readonly elevenLabsModelId = this.env.ELEVENLABS_MODEL_ID;
  /** The default voice first, then the configured options, without repeats. */
  readonly elevenLabsVoices = parseVoices(this.env.ELEVENLABS_VOICE_ID, this.env.ELEVENLABS_VOICE_OPTIONS);
  readonly r2AccountId = this.env.R2_ACCOUNT_ID;
  readonly r2AccessKeyId = this.env.R2_ACCESS_KEY_ID;
  readonly r2SecretAccessKey = this.env.R2_SECRET_ACCESS_KEY;
  readonly r2Bucket = this.env.R2_BUCKET;
  readonly r2PublicBaseUrl = this.env.R2_PUBLIC_BASE_URL;
  readonly allowPlaceholderAudio = this.env.ALLOW_PLACEHOLDER_AUDIO;
  readonly enableCron = this.env.ENABLE_CRON;
  readonly rankingEnabled = this.env.RANKING_ENABLED;
  readonly freemiumEnabled = this.env.FREEMIUM_ENABLED;
  readonly freeMaxTopics = this.env.FREE_MAX_TOPICS;
  readonly freeMaxNewWords = this.env.FREE_MAX_NEW_WORDS;
  readonly redeemEnabled = this.env.REDEEM_ENABLED;
  readonly adEverySessions = this.env.AD_EVERY_SESSIONS;
  readonly appStoreBundleId = this.env.APPSTORE_BUNDLE_ID;
  readonly appStoreProductIds = this.env.APPSTORE_PRODUCT_IDS;
  readonly appStoreAllowXcode = this.env.APPSTORE_ALLOW_XCODE;
  readonly appStoreRootFingerprints = this.env.APPSTORE_ROOT_FINGERPRINTS;
  readonly playStorePackageName = this.env.PLAYSTORE_PACKAGE_NAME;
  readonly playStoreProductIds = this.env.PLAYSTORE_PRODUCT_IDS;
  readonly playStoreServiceAccount = this.env.PLAYSTORE_SERVICE_ACCOUNT_JSON;
  readonly playStorePushAudience = this.env.PLAYSTORE_PUSH_AUDIENCE;
  readonly playStorePushServiceAccount = this.env.PLAYSTORE_PUSH_SERVICE_ACCOUNT;
  readonly appleAndroidPackage = this.env.APPLE_ANDROID_PACKAGE;
  readonly seedAdminUsername = this.env.SEED_ADMIN_USERNAME;
  readonly seedAdminEmail = this.env.SEED_ADMIN_EMAIL;
  readonly seedAdminPassword = this.env.SEED_ADMIN_PASSWORD;
  readonly corsOrigins = this.env.CORS_ORIGINS;
  readonly appVersion = this.env.APP_VERSION;
  readonly appCommit = this.env.APP_COMMIT;
}

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
}

const serviceAccountSchema = z.object({ client_email: z.email(), private_key: z.string().min(1), private_key_id: z.string().optional() });

/** A Google service account key file, given as its JSON or base64 of it. */
export function parseServiceAccount(raw: string, ctx: z.RefinementCtx): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let parsed: z.ZodSafeParseResult<z.infer<typeof serviceAccountSchema>>;
  try {
    parsed = serviceAccountSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = serviceAccountSchema.safeParse(null);
  }
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'Not a service account key (JSON or base64 of it)' });
    return z.NEVER;
  }
  return { clientEmail: parsed.data.client_email, privateKey: parsed.data.private_key, privateKeyId: parsed.data.private_key_id };
}

export function parseVoices(defaultId: string | undefined, options: string | undefined) {
  const entries = (options ?? '').split(',').map((entry) => {
    const [id, ...label] = entry.split(':');
    return { id: id.trim(), name: label.join(':').trim() || id.trim() };
  }).filter((v) => v.id);
  const voices = defaultId ? [{ id: defaultId, name: entries.find((v) => v.id === defaultId)?.name ?? defaultId }, ...entries] : entries;
  return voices.filter((v, i) => voices.findIndex((o) => o.id === v.id) === i);
}
