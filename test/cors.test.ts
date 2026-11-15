import { CORS_TEST_ORIGIN, createHarness, Harness } from './support/app';

describe('CORS', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(() => h.close());

  const preflight = (origin: string) =>
    h.http().options('/v1/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

  it('answers a preflight from an allowed origin', async () => {
    const res = await preflight(CORS_TEST_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CORS_TEST_ORIGIN);
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
  });

  it('gives no allow-origin to an unknown origin', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds allow-origin to a real response', async () => {
    const res = await h.http().get('/health').set('Origin', CORS_TEST_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(CORS_TEST_ORIGIN);
  });
});
