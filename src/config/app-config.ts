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
  ALLOW_PLACEHOLDER_AUDIO: z.stringbool().default(false),
  ENABLE_CRON: z.stringbool().default(true),
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
  readonly allowPlaceholderAudio = this.env.ALLOW_PLACEHOLDER_AUDIO;
  readonly enableCron = this.env.ENABLE_CRON;
}
