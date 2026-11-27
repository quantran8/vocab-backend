import { Body, Controller, Get, HttpCode, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-fastify/multipart';
import { AdminOnly } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { POLICY } from '../../../config/policy';
import {
  GenerateAudio, generateAudioSchema, ListAudioMissing, listAudioMissingSchema, ListAudioStale, listAudioStaleSchema, RefreshAudio, refreshAudioSchema,
} from '../dto/admin.schemas';
import { AdminAudioService, AudioUpload } from '../services/admin-audio.service';

@AdminOnly()
@Controller('admin/audio')
export class AdminAudioController {
  constructor(private readonly audio: AdminAudioService) {}

  @Get('status')
  status() {
    return this.audio.status();
  }

  /** Default-accent pronunciations without audio. */
  @Get('missing')
  missing(@Query(new ZodPipe(listAudioMissingSchema)) query: ListAudioMissing) {
    return this.audio.listMissing(query);
  }

  /** Live publications whose snapshot plays older audio than the pronunciation now has. */
  @Get('stale-publications')
  stale(@Query(new ZodPipe(listAudioStaleSchema)) query: ListAudioStale) {
    return this.audio.listStale(query);
  }

  @Post('stale-publications/refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshAudioSchema)) body: RefreshAudio) {
    return this.audio.refreshPublications(body);
  }

  /** Call again until `remaining` is 0 to voice every pronunciation. */
  @Post('generate')
  @HttpCode(200)
  generate(@Body(new ZodPipe(generateAudioSchema)) body: GenerateAudio) {
    return this.audio.generate(body);
  }

  /** Multipart field `audio`; returns the public URL to put in a pronunciation's audioAssetKey. */
  @Post('upload')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: POLICY.audio.maxUploadBytes } }))
  upload(@UploadedFile() audio?: AudioUpload) {
    return this.audio.upload(audio);
  }
}
