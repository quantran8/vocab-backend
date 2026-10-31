import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { count as countRows, SQL, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { seedTopic, SeedWord } from '../../src/seed/seed-content';
import { AppModule } from '../../src/app.module';
import { Clock } from '../../src/common/clock';
import { VALIDITY } from '../../src/common/constants/domain';
import { addHours } from '../../src/common/constants/time';
import { createHttpAdapter } from '../../src/common/http/http-adapter';
import { DB, Db, QueryStats } from '../../src/db/db';
import { AdminService } from '../../src/modules/admin/admin.service';
import { PublicationService } from '../../src/modules/admin/publication.service';
import { PlannerService } from '../../src/modules/session-planner/planner.service';
import { SpeechProvider, SpeechResult } from '../../src/modules/speech/speech.provider';

export const START = new Date('2026-11-02T03:00:00Z');
export const CAPS = { audioPlayback: true, microphone: true };
const ISSUER_PATH = '/auth/v1';

export class TestClock extends Clock {
  current = START;
  override now() { return this.current; }
  advance(hours: number) { this.current = addHours(this.current, hours); }
}

export class FakeSpeech extends SpeechProvider {
  next: SpeechResult | Error = { validity: VALIDITY.valid, accuracyScore: 90, meta: {} };
  async assess() {
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

export const seedWord = (i: number, overrides: Partial<SeedWord> = {}): SeedWord => {
  const lemma = `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}`;
  return {
    lemma, partOfSpeech: 'verb', ipa: `/w${i}/`, cefrLevel: 'B1', meaningText: `nghĩa ${i}`, definitionText: `định nghĩa ${i}`,
    example: `Use ${lemma} here.`, translation: `Dùng từ ${i} ở đây.`,
    audioUrl: `https://cdn.example.invalid/audio/asset-${i}-${randomUUID()}.mp3`, ...overrides,
  };
};

export interface Harness {
  app: NestFastifyApplication;
  db: Db;
  count: (table: PgTable, where?: SQL) => Promise<number>;
  first: <T extends PgTable>(table: T, where?: SQL) => Promise<T['$inferSelect']>;
  clock: TestClock;
  speech: FakeSpeech;
  planner: PlannerService;
  http: () => ReturnType<typeof request>;
  token: (subject: string, role?: string) => Promise<string>;
  seed: (slug: string, words: SeedWord[]) => ReturnType<typeof seedTopic>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
  countQueries: <T>(run: () => Promise<T>) => Promise<{ result: T; queries: number }>;
}

export async function createHarness(): Promise<Harness> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  const jwks: Server = createServer((_, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    SUPABASE_URL: base,
    ALLOW_PLACEHOLDER_AUDIO: 'true',
    ENABLE_CRON: 'false',
  });

  const clock = new TestClock();
  const speech = new FakeSpeech();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock).useValue(clock)
    .overrideProvider(SpeechProvider).useValue(speech)
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(createHttpAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const db = app.get<Db>(DB);
  const stats = app.get(QueryStats);

  return {
    app, db, clock, speech,
    count: async (table, where) => (await db.select({ n: countRows() }).from(table).where(where))[0].n,
    first: async (table, where) => {
      const [row] = await db.select().from(table as PgTable).where(where).limit(1);
      if (!row) throw new Error('No row found');
      return row as never;
    },
    planner: app.get(PlannerService),
    http: () => request(app.getHttpServer()),
    token: (subject, role) =>
      new SignJWT({ app_metadata: role ? { role } : {} })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setSubject(subject).setIssuer(`${base}${ISSUER_PATH}`).setAudience('authenticated').setExpirationTime('1h')
        .sign(privateKey),
    seed: (slug, words) => seedTopic({ db, admin: app.get(AdminService), publications: app.get(PublicationService) }, slug, words),
    reset: async () => {
      clock.current = START;
      const { rows } = await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
      await db.execute(sql.raw(`TRUNCATE ${rows.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`));
    },
    close: async () => {
      await app.close();
      jwks.close();
    },
    countQueries: async (run) => {
      const before = stats.count;
      const result = await run();
      return { result, queries: stats.count - before };
    },
  };
}
