import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { credentialsSchema, idTokenSchema, loginSchema, recoverSchema, recoverVerifySchema, refreshSchema } from '../dto/auth.schemas';
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
  login(@Body(new ZodPipe(loginSchema, 'VALIDATION_FAILED')) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body);
  }

  @Post('google')
  @HttpCode(200)
  google(@Body(new ZodPipe(idTokenSchema, 'VALIDATION_FAILED')) body: z.infer<typeof idTokenSchema>) {
    return this.auth.google(body);
  }

  @Post('apple')
  @HttpCode(200)
  apple(@Body(new ZodPipe(idTokenSchema, 'VALIDATION_FAILED')) body: z.infer<typeof idTokenSchema>) {
    return this.auth.apple(body);
  }

  // Sends Supabase's reset-password email with a code for `recover/verify`.
  @Post('recover')
  @HttpCode(200)
  recover(@Body(new ZodPipe(recoverSchema, 'VALIDATION_FAILED')) body: z.infer<typeof recoverSchema>) {
    return this.auth.recover(body);
  }

  @Post('recover/verify')
  @HttpCode(200)
  recoverVerify(@Body(new ZodPipe(recoverVerifySchema, 'VALIDATION_FAILED')) body: z.infer<typeof recoverVerifySchema>) {
    return this.auth.recoverVerify(body);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshSchema, 'VALIDATION_FAILED')) body: z.infer<typeof refreshSchema>) {
    return this.auth.refresh(body.refreshToken);
  }
}
