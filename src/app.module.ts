import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SupabaseJwtGuard } from './common/auth/supabase-jwt.guard';
import { UserIdCache } from './common/auth/user-id-cache';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { DbModule } from './db/db.module';
import { AdminController } from './modules/admin/controllers/admin.controller';
import { AdminCatalogController, AdminPracticeItemsController, AdminUsersController, AdminWordsController } from './modules/admin/controllers/admin-content.controller';
import { AdminCatalogService } from './modules/admin/services/admin-catalog.service';
import { AdminPracticeItemsService } from './modules/admin/services/admin-practice-items.service';
import { AdminUsersService } from './modules/admin/services/admin-users.service';
import { AdminWordsService } from './modules/admin/services/admin-words.service';
import { AdminService } from './modules/admin/services/admin.service';
import { PublicationService } from './modules/admin/services/publication.service';
import { PublicationRepository } from './modules/admin/repositories/publication.repository';
import { AdminRepository } from './modules/admin/repositories/admin.repository';
import { AdminWordsRepository } from './modules/admin/repositories/admin-words.repository';
import { AdminPracticeItemsRepository } from './modules/admin/repositories/admin-practice-items.repository';
import { AdminCatalogRepository } from './modules/admin/repositories/admin-catalog.repository';
import { AdminUsersRepository } from './modules/admin/repositories/admin-users.repository';
import { AuthController } from './modules/auth/controllers/auth.controller';
import { AuthProvider } from './modules/auth/providers/auth.provider';
import { AuthService } from './modules/auth/services/auth.service';
import { CatalogController } from './modules/catalog/controllers/catalog.controller';
import { AnthropicLexicalProvider } from './modules/custom-words/providers/anthropic-lexical.provider';
import { AudioStorage, SupabaseAudioStorage } from './modules/custom-words/providers/audio-storage';
import { CustomWordsController } from './modules/custom-words/controllers/custom-words.controller';
import { AccountDeletionRepository } from './modules/identity/repositories/account-deletion.repository';
import { IdentityRepository } from './modules/identity/repositories/identity.repository';
import { CheckpointRepository } from './modules/checkpoint/repositories/checkpoint.repository';
import { MaintenanceRepository } from './modules/maintenance/repositories/maintenance.repository';
import { CatalogRepository } from './modules/catalog/repositories/catalog.repository';
import { SpeechRepository } from './modules/speech/repositories/speech.repository';
import { UserProvisioningRepository } from './common/auth/user-provisioning.repository';
import { CommitRepository } from './modules/session-commit/repositories/commit.repository';
import { ProgressRepository } from './modules/progress/repositories/progress.repository';
import { CustomWordsRepository } from './modules/custom-words/repositories/custom-words.repository';
import { CustomWordsService } from './modules/custom-words/services/custom-words.service';
import { CustomWordsWorker } from './modules/custom-words/workers/custom-words.worker';
import { LexicalProvider } from './modules/custom-words/providers/lexical.provider';
import { ElevenLabsTtsProvider, TtsProvider } from './modules/custom-words/providers/tts.provider';
import { AccountDeletionService } from './modules/identity/services/account-deletion.service';
import { IdentityController } from './modules/identity/controllers/identity.controller';
import { IdentityService } from './modules/identity/services/identity.service';
import { MaintenanceService } from './modules/maintenance/services/maintenance.service';
import { ProgressController } from './modules/progress/controllers/progress.controller';
import { ProgressService } from './modules/progress/services/progress.service';
import { CommitService } from './modules/session-commit/services/commit.service';
import { SessionCommitController } from './modules/session-commit/controllers/session-commit.controller';
import { PlacementController } from './modules/placement/controllers/placement.controller';
import { PlacementRepository } from './modules/placement/repositories/placement.repository';
import { PlacementService } from './modules/placement/services/placement.service';
import { PlannerRepository } from './modules/session-planner/repositories/planner.repository';
import { PlannerService } from './modules/session-planner/services/planner.service';
import { SessionPlannerController } from './modules/session-planner/controllers/session-planner.controller';
import { SpeechController } from './modules/speech/controllers/speech.controller';
import { AzureRestSpeechProvider, SpeechProvider } from './modules/speech/providers/speech.provider';
import { SpeechService } from './modules/speech/services/speech.service';
import { CheckpointController } from './modules/checkpoint/controllers/checkpoint.controller';
import { CheckpointService } from './modules/checkpoint/services/checkpoint.service';
import { HealthController } from './modules/health/health.controller';

@Module({
  imports: [DbModule, ScheduleModule.forRoot()],
  controllers: [
    AuthController, IdentityController, PlacementController, CatalogController, ProgressController, SessionPlannerController,
    SessionCommitController, SpeechController, CheckpointController, CustomWordsController, AdminController,
    AdminWordsController, AdminPracticeItemsController, AdminCatalogController, AdminUsersController,
    HealthController,
  ],
  providers: [
    UserIdCache, UserProvisioningRepository, SpeechRepository,
    { provide: APP_GUARD, useClass: SupabaseJwtGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: SpeechProvider, useClass: AzureRestSpeechProvider },
    { provide: LexicalProvider, useClass: AnthropicLexicalProvider },
    { provide: TtsProvider, useClass: ElevenLabsTtsProvider },
    { provide: AudioStorage, useClass: SupabaseAudioStorage },
    AuthProvider, AuthService, IdentityService, PlacementRepository, PlacementService, AccountDeletionService, ProgressService, PlannerRepository, PlannerService, CommitService,
    SpeechService, CheckpointService, MaintenanceService, AdminService, PublicationService,
    AdminRepository, PublicationRepository, AdminWordsRepository, AdminPracticeItemsRepository, AdminCatalogRepository, AdminUsersRepository,
    AdminWordsService, AdminPracticeItemsService, AdminCatalogService, AdminUsersService,
    CommitRepository, ProgressRepository, IdentityRepository, AccountDeletionRepository, CheckpointRepository, MaintenanceRepository, CatalogRepository,
    CustomWordsRepository, CustomWordsService, CustomWordsWorker,
  ],
})
export class AppModule {}
