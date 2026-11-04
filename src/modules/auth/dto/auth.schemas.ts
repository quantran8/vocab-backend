import { z } from 'zod';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
// Supabase's own minimum is configurable; this is only an upper bound against abuse (bcrypt limit is 72 bytes).
const password = z.string().min(8).max(72);

export const credentialsSchema = z.strictObject({ email, password });

// An address, or the seeded admin's login name: AuthService resolves it against config.
const loginName = z.string().trim().toLowerCase().min(1).max(254);
export const loginSchema = z.strictObject({ email: loginName, password });

export const googleSchema = z.strictObject({
  idToken: z.string().min(1),
  // Raw nonce when the client hashed it into the Google token request.
  nonce: z.string().min(1).optional(),
});

export const refreshSchema = z.strictObject({ refreshToken: z.string().min(1) });
