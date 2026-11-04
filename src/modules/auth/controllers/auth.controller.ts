import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { credentialsSchema, googleSchema, refreshSchema } from '../dto/auth.schemas';
import { AuthService } from '../services/auth.service';

@Public()
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  signup(@Body(new ZodPipe(credentialsSchema, 'VALIDATION_FAILED')) body: z.infer<typeof credentialsSchema>) {
    return this.auth.signup(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(credentialsSchema, 'VALIDATION_FAILED')) body: z.infer<typeof credentialsSchema>) {
    return this.auth.login(body);
  }

  @Post('google')
  @HttpCode(200)
  google(@Body(new ZodPipe(googleSchema, 'VALIDATION_FAILED')) body: z.infer<typeof googleSchema>) {
    return this.auth.google(body);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshSchema, 'VALIDATION_FAILED')) body: z.infer<typeof refreshSchema>) {
    return this.auth.refresh(body.refreshToken);
  }
}
