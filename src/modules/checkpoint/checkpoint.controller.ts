import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { CheckpointService } from './checkpoint.service';

@Controller('v1/me/checkpoint-challenges')
export class CheckpointController {
  constructor(private readonly checkpoints: CheckpointService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return { challenges: await this.checkpoints.list(user.id) };
  }
}
