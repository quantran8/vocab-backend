import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AccountDeletionService } from './account-deletion.service';
import { levelsSchema, scopeSchema, settingsSchema } from './identity.schemas';
import { IdentityService } from './identity.service';

@Controller('v1/me')
export class IdentityController {
  constructor(private readonly identity: IdentityService, private readonly accounts: AccountDeletionService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.identity.getMe(user.id);
  }

  @Delete()
  remove(@CurrentUser() user: AuthUser) {
    return this.accounts.deleteAccount(user);
  }

  @Put('levels')
  levels(@CurrentUser() user: AuthUser, @Body(new ZodPipe(levelsSchema)) body: z.infer<typeof levelsSchema>) {
    return this.identity.setLevels(user.id, body);
  }

  @Put('settings')
  settings(@CurrentUser() user: AuthUser, @Body(new ZodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.identity.updateSettings(user.id, body);
  }

  @Put('scope')
  scope(@CurrentUser() user: AuthUser, @Body(new ZodPipe(scopeSchema)) body: z.infer<typeof scopeSchema>) {
    return this.identity.setScope(user.id, body);
  }
}
