import { ADMIN_ROLE } from '../common/constants/domain';
import { ApiError } from '../common/http/api-error';
import { AppConfig } from '../config/app-config';
import { AuthProvider, ProviderAdminUser } from '../modules/auth/providers/auth.provider';

const PAGE_SIZE = 100;

// GoTrue's admin list has no email filter, so this walks the pages.
async function findByEmail(auth: AuthProvider, email: string): Promise<ProviderAdminUser | undefined> {
  for (let page = 1; ; page += 1) {
    const { users } = await auth.listUsers(page, PAGE_SIZE);
    const found = users.find((user) => user.email === email);
    if (found || users.length < PAGE_SIZE) return found;
  }
}

/** An existing account keeps its password, so a rotated one survives re-seeding. Never promotes: see memory admin-crud-rules. */
export async function seedAdmin(auth: AuthProvider, { seedAdminEmail: email, seedAdminPassword: password }: Pick<AppConfig, 'seedAdminEmail' | 'seedAdminPassword'>) {
  if (!email || !password) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to seed the admin account');
  try {
    await auth.createConfirmedUser(email, password, ADMIN_ROLE.ADMIN);
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'EMAIL_ALREADY_REGISTERED')) throw error;
    const existing = await findByEmail(auth, email);
    if (existing?.app_metadata?.role !== ADMIN_ROLE.ADMIN) {
      throw new Error(`${email} already exists without the admin role; remove that account and seed again`, { cause: error });
    }
  }
}
