import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SupabaseJwtGuard } from './common/auth/supabase-jwt.guard';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { DbModule } from './db/db.module';
import { AdminController } from './modules/admin/admin.controller';
import { AdminService } from './modules/admin/admin.service';
import { PublicationService } from './modules/admin/publication.service';
import { CatalogController } from './modules/catalog/catalog.controller';
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
import { WeeklyController } from './modules/weekly/weekly.controller';
import { WeeklyService } from './modules/weekly/weekly.service';

@Module({
  imports: [DbModule, ScheduleModule.forRoot()],
  controllers: [
    IdentityController, CatalogController, ProgressController, SessionPlannerController,
    SessionCommitController, SpeechController, WeeklyController, AdminController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: SupabaseJwtGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: SpeechProvider, useClass: AzureRestSpeechProvider },
    IdentityService, ProgressService, PlannerRepository, PlannerService, CommitService,
    SpeechService, WeeklyService, MaintenanceService, AdminService, PublicationService,
  ],
})
export class AppModule {}
