import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AdminOnly } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { GenerateAudio, generateAudioSchema } from '../dto/admin.schemas';
import { AdminAudioService } from '../services/admin-audio.service';

@AdminOnly()
@Controller('admin/audio')
export class AdminAudioController {
  constructor(private readonly audio: AdminAudioService) {}

  @Get('status')
  status() {
    return this.audio.status();
  }

  /** Call again until `remaining` is 0 to voice every pronunciation. */
  @Post('generate')
  @HttpCode(200)
  generate(@Body(new ZodPipe(generateAudioSchema)) body: GenerateAudio) {
    return this.audio.generate(body);
  }
}
