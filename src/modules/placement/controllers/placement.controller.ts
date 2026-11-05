import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { PlacementSubmit, placementSubmitSchema } from '../dto/placement.schemas';
import { PlacementService } from '../services/placement.service';

@Controller('v1/me/placement-test')
export class PlacementController {
  constructor(private readonly placement: PlacementService) {}

  @Get()
  test(@CurrentUser() user: AuthUser) {
    return this.placement.getTest(user.id);
  }

  @Post()
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Body(new ZodPipe(placementSubmitSchema)) body: PlacementSubmit) {
    return this.placement.submit(user.id, body);
  }
}
