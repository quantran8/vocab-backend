import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { uuidv7 } from 'uuidv7';
import { AppConfig } from '../../config/app-config';
import { DB, Db } from '../../db/db';
import { ADMIN_ROLES } from '../constants/domain';
import { ApiError } from '../http/api-error';
import { AuthUser, IS_ADMIN, IS_PUBLIC } from './auth.decorators';
import { UserIdCache } from './user-id-cache';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  private readonly jwks;

  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
    private readonly config: AppConfig,
    private readonly userIds: UserIdCache,
  ) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  }

  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers.authorization;
    if (!header?.startsWith(BEARER_PREFIX)) throw new ApiError('UNAUTHORIZED', 'Missing bearer token');

    const claims = await this.verify(header.slice(BEARER_PREFIX.length));
    if (!claims.sub) throw new ApiError('UNAUTHORIZED', 'Token has no subject');

    // app_metadata is server-managed; user_metadata is user-writable and must not grant roles.
    const role = (claims.app_metadata as { role?: string } | undefined)?.role;
    if (this.reflector.getAllAndOverride<boolean>(IS_ADMIN, targets) && !this.isAdmin(role)) {
      throw new ApiError('FORBIDDEN', 'Admin role required');
    }

    let id = this.userIds.get(claims.sub);
    if (!id) {
      id = await this.provision(claims.sub);
      this.userIds.set(claims.sub, id);
    }
    const user: AuthUser = { id, subject: claims.sub, role };
    request.user = user;
    return true;
  }

  private isAdmin(role?: string) {
    return (ADMIN_ROLES as readonly string[]).includes(role ?? '');
  }

  private async verify(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      });
      return payload;
    } catch {
      throw new ApiError('UNAUTHORIZED', 'Invalid token');
    }
  }

  // One statement: creates user + settings on first sight, otherwise only reads the id.
  private async provision(subject: string) {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      WITH existing AS (
        SELECT id FROM app_user WHERE identity_subject = ${subject}
      ), inserted AS (
        INSERT INTO app_user (id, identity_subject)
        SELECT ${uuidv7()}::uuid, ${subject}::text WHERE NOT EXISTS (SELECT 1 FROM existing)
        ON CONFLICT (identity_subject) DO UPDATE SET identity_subject = EXCLUDED.identity_subject
        RETURNING id
      ), settings AS (
        INSERT INTO user_settings (user_id) SELECT id FROM inserted
        ON CONFLICT (user_id) DO NOTHING
      )
      SELECT id FROM existing UNION ALL SELECT id FROM inserted`);
    return rows[0].id;
  }
}
