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
  SUPABASE_AUDIO_BUCKET: z.string().default('pronunciation-audio'),
  ANTHROPIC_API_KEY: z.string().optional(),
  LEXICAL_AI_MODEL: z.string().default('claude-opus-5-5'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().optional(),
  ALLOW_PLACEHOLDER_AUDIO: z.stringbool().default(false),
  ENABLE_CRON: z.stringbool().default(true),
  SEED_ADMIN_USERNAME: z.string().trim().toLowerCase().min(1).optional(),
  SEED_ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
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
  readonly supabaseAudioBucket = this.env.SUPABASE_AUDIO_BUCKET;
  readonly anthropicApiKey = this.env.ANTHROPIC_API_KEY;
  readonly lexicalAiModel = this.env.LEXICAL_AI_MODEL;
  readonly elevenLabsApiKey = this.env.ELEVENLABS_API_KEY;
  readonly elevenLabsVoiceId = this.env.ELEVENLABS_VOICE_ID;
  readonly elevenLabsModelId = this.env.ELEVENLABS_MODEL_ID;
  readonly allowPlaceholderAudio = this.env.ALLOW_PLACEHOLDER_AUDIO;
  readonly enableCron = this.env.ENABLE_CRON;
  readonly seedAdminUsername = this.env.SEED_ADMIN_USERNAME;
  readonly seedAdminEmail = this.env.SEED_ADMIN_EMAIL;
  readonly seedAdminPassword = this.env.SEED_ADMIN_PASSWORD;
  readonly appVersion = this.env.APP_VERSION;
  readonly appCommit = this.env.APP_COMMIT;
}
