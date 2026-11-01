import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SupabaseJwtGuard } from './common/auth/supabase-jwt.guard';
import { UserIdCache } from './common/auth/user-id-cache';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { DbModule } from './db/db.module';
import { AdminController } from './modules/admin/admin.controller';
import { AdminService } from './modules/admin/admin.service';
import { PublicationService } from './modules/admin/publication.service';
import { AuthController } from './modules/auth/auth.controller';
import { AuthProvider } from './modules/auth/auth.provider';
import { AuthService } from './modules/auth/auth.service';
import { CatalogController } from './modules/catalog/catalog.controller';
import { AnthropicLexicalProvider } from './modules/custom-words/anthropic-lexical.provider';
import { AudioStorage, SupabaseAudioStorage } from './modules/custom-words/audio-storage';
import { CustomWordsController } from './modules/custom-words/custom-words.controller';
import { CustomWordsRepository } from './modules/custom-words/custom-words.repository';
import { CustomWordsService } from './modules/custom-words/custom-words.service';
import { CustomWordsWorker } from './modules/custom-words/custom-words.worker';
import { LexicalProvider } from './modules/custom-words/lexical.provider';
import { ElevenLabsTtsProvider, TtsProvider } from './modules/custom-words/tts.provider';
import { IdentityController } from './modules/identity/identity.controller';
import { IdentityService } from './modules/identity/identity.service';
import { MaintenanceService } from './modules/maintenance/maintenance.service';
import { ProgressController } from './modules/progress/progress.controller';
import { ProgressService } from './modules/progress/progress.service';
import { CommitService } from './modules/session-commit/commit.service';
import { SessionCommitController } from './modules/session-commit/session-commit.controller';
import { PlannerRepository } from './modules/session-planner/planner.repository';
import { PlannerService } from './modules/session-planner/planner.service';
import { SessionPlannerController } from './modules/session-planner/session-planner.controller';
import { SpeechController } from './modules/speech/speech.controller';
import { AzureRestSpeechProvider, SpeechProvider } from './modules/speech/speech.provider';
import { SpeechService } from './modules/speech/speech.service';
import { CheckpointController } from './modules/checkpoint/checkpoint.controller';
import { CheckpointService } from './modules/checkpoint/checkpoint.service';

@Module({
  imports: [DbModule, ScheduleModule.forRoot()],
  controllers: [
    AuthController, IdentityController, CatalogController, ProgressController, SessionPlannerController,
    SessionCommitController, SpeechController, CheckpointController, CustomWordsController, AdminController,
  ],
  providers: [
    UserIdCache,
    { provide: APP_GUARD, useClass: SupabaseJwtGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: SpeechProvider, useClass: AzureRestSpeechProvider },
    { provide: LexicalProvider, useClass: AnthropicLexicalProvider },
    { provide: TtsProvider, useClass: ElevenLabsTtsProvider },
    { provide: AudioStorage, useClass: SupabaseAudioStorage },
    AuthProvider, AuthService, IdentityService, ProgressService, PlannerRepository, PlannerService, CommitService,
    SpeechService, CheckpointService, MaintenanceService, AdminService, PublicationService,
    CustomWordsRepository, CustomWordsService, CustomWordsWorker,
  ],
})
export class AppModule {}
