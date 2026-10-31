import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { WeeklyService } from './weekly.service';

@Controller('v1/me/weekly-challenges')
export class WeeklyController {
  constructor(private readonly weekly: WeeklyService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return { challenges: await this.weekly.list(user.id) };
  }
}
