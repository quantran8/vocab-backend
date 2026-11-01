import { createHarness, Harness } from './support/app';

describe('Auth', () => {
  let h: Harness;
  const post = (path: string, body: object) => h.http().post(`/v1/auth/${path}`).send(body);

  beforeAll(async () => { h = await createHarness(); });
  afterAll(() => h.close());

  it('signs up and returns a session, normalizing the email', async () => {
    const { body } = await post('signup', { email: ' New@Example.com ', password: 'correct-horse' }).expect(201);
    expect(body).toEqual({
      confirmationRequired: false,
      session: { accessToken: 'access-new@example.com', refreshToken: 'refresh-new@example.com', expiresIn: 3600, user: { id: 'uid-new@example.com', email: 'new@example.com' } },
    });
  });

  it('signup without a session means email confirmation is pending', async () => {
    const { body } = await post('signup', { email: 'confirm@example.com', password: 'correct-horse' }).expect(201);
    expect(body).toEqual({ session: null, confirmationRequired: true });
  });

  it('rejects a duplicate email with 409', async () => {
    const { body } = await post('signup', { email: 'taken@example.com', password: 'correct-horse' }).expect(409);
    expect(body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects malformed input with 400', async () => {
    await post('signup', { email: 'not-an-email', password: 'correct-horse' }).expect(400);
    await post('login', { email: 'a@example.com', password: 'short' }).expect(400);
    await post('login', { email: 'a@example.com', password: 'correct-horse', extra: 1 }).expect(400);
  });

  it('logs in with email and password', async () => {
    const { body } = await post('login', { email: 'a@example.com', password: 'correct-horse' }).expect(200);
    expect(body.accessToken).toBe('access-a@example.com');
  });

  it('rejects wrong credentials with 401', async () => {
    const { body } = await post('login', { email: 'a@example.com', password: 'wrong-password' }).expect(401);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('logs in with a Google ID token', async () => {
    const { body } = await post('google', { idToken: 'good-id-token' }).expect(200);
    expect(body.user.email).toBe('g@example.com');
    await post('google', { idToken: 'bad' }).expect(401);
  });

  it('refreshes a session', async () => {
    await post('refresh', { refreshToken: 'refresh-a@example.com' }).expect(200);
    await post('refresh', { refreshToken: 'stale' }).expect(401);
  });
});
