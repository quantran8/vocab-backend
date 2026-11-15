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
  readonly seedAdminUsername = this.env.SEED_ADMIN_USERNAME;
  readonly seedAdminEmail = this.env.SEED_ADMIN_EMAIL;
  readonly seedAdminPassword = this.env.SEED_ADMIN_PASSWORD;
  readonly corsOrigins = this.env.CORS_ORIGINS;
  readonly appVersion = this.env.APP_VERSION;
  readonly appCommit = this.env.APP_COMMIT;
}

export function parseVoices(defaultId: string | undefined, options: string | undefined) {
  const entries = (options ?? '').split(',').map((entry) => {
    const [id, ...label] = entry.split(':');
    return { id: id.trim(), name: label.join(':').trim() || id.trim() };
  }).filter((v) => v.id);
  const voices = defaultId ? [{ id: defaultId, name: entries.find((v) => v.id === defaultId)?.name ?? defaultId }, ...entries] : entries;
  return voices.filter((v, i) => voices.findIndex((o) => o.id === v.id) === i);
}
