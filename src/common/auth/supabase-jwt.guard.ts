import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppConfig } from '../../config/app-config';
import { ADMIN_ROLE, ADMIN_ROLES } from '../constants/domain';
import { ApiError } from '../http/api-error';
import { AuthUser, IS_ADMIN, IS_FULL_ADMIN, IS_PUBLIC } from './auth.decorators';
import { UserIdCache } from './user-id-cache';
import { UserProvisioningRepository } from './user-provisioning.repository';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  private readonly jwks;

  constructor(
    private readonly reflector: Reflector,
    private readonly users: UserProvisioningRepository,
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
    if (this.reflector.getAllAndOverride<boolean>(IS_FULL_ADMIN, targets) && role !== ADMIN_ROLE.ADMIN) {
      throw new ApiError('FORBIDDEN', 'Admin role required');
    }

    let id = this.userIds.get(claims.sub);
    if (!id) {
      id = await this.users.provision(claims.sub);
      if (!id) throw new ApiError('UNAUTHORIZED', 'Account deleted');
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
}
