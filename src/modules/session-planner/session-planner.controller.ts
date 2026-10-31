import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { PlannerService, PlanRequest, planRequestSchema } from './planner.service';

@Controller('v1/sessions')
export class SessionPlannerController {
  constructor(private readonly planner: PlannerService) {}

  @Post('plan')
  @HttpCode(200)
  plan(@CurrentUser() user: AuthUser, @Body(new ZodPipe(planRequestSchema)) body: PlanRequest) {
    return this.planner.plan(user.id, body);
  }
}
