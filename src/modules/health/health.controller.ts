import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/auth/auth.decorators';
import { AppConfig } from '../../config/app-config';

@Controller('health')
export class HealthController {
  constructor(private readonly config: AppConfig) {}

  // The deploy compares version with the build it just pushed — see memory deployment.
  @Public()
  @Get()
  health() {
    return { status: 'ok', version: this.config.appVersion, commit: this.config.appCommit };
  }
}
