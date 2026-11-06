import { UserIdCache } from '../../src/common/auth/user-id-cache';
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
import { AdminService } from '../../src/modules/admin/services/admin.service';
import { AudioStorage } from '../../src/modules/custom-words/providers/audio-storage';
import { CustomWordsService } from '../../src/modules/custom-words/services/custom-words.service';
import { GeneratedWord, GenerateRequest, LexicalProvider, SourceMeaning, TranslatedMeaning } from '../../src/modules/custom-words/providers/lexical.provider';
import { TtsProvider } from '../../src/modules/custom-words/providers/tts.provider';
import { PublicationService } from '../../src/modules/admin/services/publication.service';
import { PlannerService } from '../../src/modules/session-planner/services/planner.service';
import { SpeechProvider, SpeechResult } from '../../src/modules/speech/providers/speech.provider';

export const START = new Date('2026-11-02T03:00:00Z');
export const CAPS = { audioPlayback: true, microphone: true };
const ISSUER_PATH = '/auth/v1';
export const ANON_KEY = 'test-anon-key';
export const SERVICE_KEY = 'test-service-key';
export const SEED_ADMIN = { USERNAME: 'admin123213', EMAIL: 'seeded-admin@example.com', PASSWORD: 'test-admin-password' };

export interface FakeAuthUser {
  id: string;
  email?: string;
  app_metadata?: { role?: string };
  created_at?: string;
  last_sign_in_at?: string | null;
}

const fakeSession = (email: string) => ({
  access_token: `access-${email}`, refresh_token: `refresh-${email}`, expires_in: 3600, user: { id: `uid-${email}`, email },
});
const reject = (status: number, error_code: string): [number, object] => [status, { error_code, msg: error_code }];

// Minimal GoTrue stand-in: just enough shapes for /v1/auth/*.
function fakeAuth(url: string, apikey: string | string[] | undefined, body: Record<string, string>): [number, object] {
  if (apikey !== ANON_KEY) return reject(401, 'no_authorization');
  if (url.endsWith('/signup')) {
    if (body.email === 'taken@example.com') return reject(422, 'user_already_exists');
    if (body.email.startsWith('confirm')) return [200, { id: 'uid-pending', email: body.email }];
    return [200, fakeSession(body.email)];
  }
  if (url.endsWith('grant_type=password')) {
    return body.password === 'correct-horse' ? [200, fakeSession(body.email)] : reject(400, 'invalid_credentials');
  }
  if (url.endsWith('grant_type=id_token')) {
    return body.provider === 'google' && body.id_token === 'good-id-token' ? [200, fakeSession('g@example.com')] : reject(400, 'invalid_credentials');
  }
  if (url.endsWith('grant_type=refresh_token')) {
    return body.refresh_token === 'refresh-a@example.com' ? [200, fakeSession('a@example.com')] : reject(400, 'refresh_token_not_found');
  }
  return reject(404, 'not_found');
}

export class TestClock extends Clock {
  current = START;
  override now() { return this.current; }
  advance(hours: number) { this.current = addHours(this.current, hours); }
}

export class FakeSpeech extends SpeechProvider {
  next: SpeechResult | Error = { validity: VALIDITY.VALID, accuracyScore: 90, meta: {} };
  async assess() {
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

const sense = (lemma: string, locale: string, overrides: Partial<GeneratedWord['senses'][number]> = {}): GeneratedWord['senses'][number] => ({
  partOfSpeech: 'noun', ipa: `/${lemma}/`, cefrLevel: 'B1', popularity: 50, meaningText: `${locale} gloss of ${lemma}`, definitionText: `${locale} definition of ${lemma}`,
  examples: [{ text: `Use ${lemma} here.`, translation: `${locale} sentence`, target: lemma }], ...overrides,
});

export class FakeLexical extends LexicalProvider {
  readonly model = 'fake-model';
  generated: GenerateRequest[] = [];
  translated: SourceMeaning[][] = [];
  lemmas = new Map<string, string>();
  invalid = new Set<string>();
  duplicateOf: number | null = null;
  ipa?: string;
  error?: Error;

  async generate(request: GenerateRequest): Promise<GeneratedWord> {
    this.generated.push(request);
    if (this.error) throw this.error;
    const lemma = this.lemmas.get(request.text) ?? request.text;
    if (this.invalid.has(request.text)) return { isValidWord: false, lemma, duplicateOfIndex: null, senses: [] };
    if (this.duplicateOf !== null) return { isValidWord: true, lemma, duplicateOfIndex: this.duplicateOf, senses: [] };
    const senses = request.context
      ? [sense(lemma, request.locale, { partOfSpeech: 'verb', meaningText: `${request.locale} ${request.context}`, ...(this.ipa && { ipa: this.ipa }) })]
      : [sense(lemma, request.locale), sense(lemma, request.locale, { partOfSpeech: 'verb', meaningText: `${request.locale} verb of ${lemma}` })];
    return { isValidWord: true, lemma, duplicateOfIndex: null, senses };
  }

  async translate(sources: SourceMeaning[], locale: string): Promise<TranslatedMeaning[]> {
    this.translated.push(sources);
    if (this.error) throw this.error;
    return sources.map((s) => ({
      meaningText: `${locale} gloss of ${s.lemma}`, definitionText: `${locale} definition of ${s.lemma}`, exampleTranslations: s.examples.map(() => `${locale} sentence`),
    }));
  }
}

export class FakeTts extends TtsProvider {
  readonly voice = 'fake-voice';
  calls: string[] = [];
  error?: Error;
  async synthesize(text: string) {
    this.calls.push(text);
    if (this.error) throw this.error;
    return Buffer.from('mp3');
  }
}

export class FakeAudioStorage extends AudioStorage {
  async upload(key: string) {
    return `https://cdn.example.invalid/${key}`;
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

export class FakeAuthAdmin {
  deleted: string[] = [];
  deleteStatus = 200;
}

export interface Harness {
  app: NestFastifyApplication;
  db: Db;
  count: (table: PgTable, where?: SQL) => Promise<number>;
  first: <T extends PgTable>(table: T, where?: SQL) => Promise<T['$inferSelect']>;
  authUsers: FakeAuthUser[];
  clock: TestClock;
  speech: FakeSpeech;
  lexical: FakeLexical;
  tts: FakeTts;
  authAdmin: FakeAuthAdmin;
  customWords: CustomWordsService;
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
  const authUsers: FakeAuthUser[] = [];
  const authAdmin = new FakeAuthAdmin();
  const jwks: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '';
    const isAdminCall = url.includes('/admin/users');
    if (isAdminCall && req.headers.apikey !== SERVICE_KEY) {
      res.statusCode = 401;
      return void res.end('{}');
    }
    if (isAdminCall && req.method === 'GET' && !url.includes('?')) {
      const target = authUsers.find((u) => url.endsWith(`/${u.id}`));
      res.statusCode = target ? 200 : 404;
      return void res.end(JSON.stringify(target ?? {}));
    }
    if (isAdminCall && req.method === 'GET') {
      const params = new URL(url, 'http://fake').searchParams;
      const perPage = Number(params.get('per_page'));
      const start = (Number(params.get('page')) - 1) * perPage;
      res.setHeader('x-total-count', String(authUsers.length));
      return void res.end(JSON.stringify({ users: authUsers.slice(start, start + perPage) }));
    }
    if (isAdminCall && req.method === 'DELETE') {
      res.statusCode = authAdmin.deleteStatus;
      if (res.statusCode === 200) authAdmin.deleted.push(decodeURIComponent(url.split('/').pop() ?? ''));
      return void res.end('{}');
    }
    if (req.method !== 'POST' && !isAdminCall) return void res.end(JSON.stringify({ keys: [jwk] }));
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (isAdminCall && req.method === 'POST') {
        const created = JSON.parse(raw) as { email: string; app_metadata: { role?: string } };
        if (authUsers.some((u) => u.email === created.email)) {
          res.statusCode = 422;
          return void res.end(JSON.stringify({ error_code: 'email_exists', msg: 'exists' }));
        }
        const user = { id: randomUUID(), email: created.email, app_metadata: created.app_metadata };
        authUsers.push(user);
        return void res.end(JSON.stringify(user));
      }
      if (isAdminCall) {
        const target = authUsers.find((u) => url.endsWith(`/${u.id}`));
        if (!target) {
          res.statusCode = 404;
          return void res.end('{}');
        }
        const { role } = (JSON.parse(raw) as { app_metadata: { role: string | null } }).app_metadata;
        target.app_metadata = role ? { role } : {};
        return void res.end(JSON.stringify(target));
      }
      const [status, body] = fakeAuth(req.url ?? '', req.headers.apikey, JSON.parse(raw));
      res.statusCode = status;
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    SUPABASE_URL: base,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    SEED_ADMIN_USERNAME: SEED_ADMIN.USERNAME,
    SEED_ADMIN_EMAIL: SEED_ADMIN.EMAIL,
    SEED_ADMIN_PASSWORD: SEED_ADMIN.PASSWORD,
    ALLOW_PLACEHOLDER_AUDIO: 'true',
    ENABLE_CRON: 'false',
  });

  const clock = new TestClock();
  const speech = new FakeSpeech();
  const lexical = new FakeLexical();
  const tts = new FakeTts();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock).useValue(clock)
    .overrideProvider(SpeechProvider).useValue(speech)
    .overrideProvider(LexicalProvider).useValue(lexical)
    .overrideProvider(TtsProvider).useValue(tts)
    .overrideProvider(AudioStorage).useValue(new FakeAudioStorage())
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(createHttpAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const db = app.get<Db>(DB);
  const stats = app.get(QueryStats);

  return {
    app, db, authUsers, authAdmin, clock, speech, lexical, tts,
    customWords: app.get(CustomWordsService),
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
      authUsers.length = 0;
      app.get(UserIdCache).clear();
      Object.assign(lexical, { generated: [], translated: [], duplicateOf: null, ipa: undefined, error: undefined });
      lexical.lemmas.clear();
      lexical.invalid.clear();
      Object.assign(tts, { calls: [], error: undefined });
      Object.assign(authAdmin, { deleted: [], deleteStatus: 200 });
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
