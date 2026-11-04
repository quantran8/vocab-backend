import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
export const IS_ADMIN = 'isAdmin';
export const IS_FULL_ADMIN = 'isFullAdmin';

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const AdminOnly = () => SetMetadata(IS_ADMIN, true);
/** Stricter than AdminOnly: an editor is refused. */
export const FullAdminOnly = () => SetMetadata(IS_FULL_ADMIN, true);

export interface AuthUser {
  id: string;
  subject: string;
  role?: string;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
