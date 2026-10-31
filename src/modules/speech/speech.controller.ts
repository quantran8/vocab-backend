import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-fastify/multipart';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { POLICY } from '../../config/policy';
import { SpeechService } from './speech.service';

const AUDIO_FIELD = 'audio';
const assessBodySchema = z.object({ taskId: z.uuid() });

@Controller('v1/sessions/:sessionId')
export class SpeechController {
  constructor(private readonly speech: SpeechService) {}

  @Post('recording-assess')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor(AUDIO_FIELD, { limits: { fileSize: POLICY.speech.maxAudioBytes } }))
  assess(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodPipe(assessBodySchema, 'INVALID_SUBMISSION')) body: z.infer<typeof assessBodySchema>,
    @UploadedFile() audio?: { buffer: Buffer; mimetype: string },
  ) {
    return this.speech.assess(user.id, sessionId, body.taskId, audio);
  }
}
