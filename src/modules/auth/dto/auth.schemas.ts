import { z } from 'zod';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
// Supabase's own minimum is configurable; this is only an upper bound against abuse (bcrypt limit is 72 bytes).
const password = z.string().min(8).max(72);
// A password being created must also mix letters and digits (the app shows these rules).
// Logging in only checks length, so older passwords keep working.
const newPassword = password
  .regex(/\p{L}/u, 'Password needs at least one letter')
  .regex(/\p{Nd}/u, 'Password needs at least one number');

export const credentialsSchema = z.strictObject({ email, password: newPassword });

// An address, or the seeded admin's login name: AuthService resolves it against config.
const loginName = z.string().trim().toLowerCase().min(1).max(254);
export const loginSchema = z.strictObject({ email: loginName, password });

export const idTokenSchema = z.strictObject({
  idToken: z.string().min(1),
  // Raw nonce when the client hashed it into the Google or Apple token request.
  nonce: z.string().min(1).optional(),
});

export const recoverSchema = z.strictObject({ email });

// The 6-digit code from the reset email, and the new password.
export const recoverVerifySchema = z.strictObject({ email, code: z.string().trim().regex(/^\d{6,10}$/), password: newPassword });

export const changePasswordSchema = z.strictObject({ currentPassword: password, newPassword });

export const refreshSchema = z.strictObject({ refreshToken: z.string().min(1) });
