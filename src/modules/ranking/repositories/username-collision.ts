import { constraintOf } from '../../admin/domain/admin.errors';
import { generateUsername } from '../domain/username';

export const USERNAME_UNIQUE = 'app_user_username_key';
const GENERATION_ATTEMPTS = 3;

export const isUsernameTaken = (error: unknown) => constraintOf(error) === USERNAME_UNIQUE;

/** Generated names rarely collide (32 × 32 × 10 000), so a retry with a fresh one is enough. */
export async function withGeneratedUsername<T>(run: (username: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(generateUsername());
    } catch (error) {
      if (!isUsernameTaken(error) || attempt >= GENERATION_ATTEMPTS) throw error;
    }
  }
}
