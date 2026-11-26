import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { AppConfig } from '../../../config/app-config';
import { appleCallbackSchema, credentialsSchema, idTokenSchema, loginSchema, recoverSchema, recoverVerifySchema, refreshSchema } from '../dto/auth.schemas';
import { AuthService } from '../services/auth.service';

// The app's callback scheme (AppleSignInCallbackActivity on Android).
const APPLE_ANDROID_SCHEME = 'syll-apple';

@Public()
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

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

  // Sign in with Apple on Android (web flow in a Custom Tab): this is the Services ID's return URL. Apple posts the
  // result here and the browser is sent back to the app, which checks `state` and posts the ID token to `auth/apple`
  // like iOS. Nothing is verified or stored here.
  @Post('apple/callback')
  appleCallback(@Body(new ZodPipe(appleCallbackSchema, 'VALIDATION_FAILED')) body: z.infer<typeof appleCallbackSchema>, @Res() reply: FastifyReply) {
    const query = new URLSearchParams(Object.entries(body).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const target = `intent://callback?${query}#Intent;package=${this.config.appleAndroidPackage};scheme=${APPLE_ANDROID_SCHEME};end`;
    return reply.code(303).header('location', target).header('cache-control', 'no-store').send();
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
