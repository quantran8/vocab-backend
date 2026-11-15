import { INestApplication } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';

const PREFLIGHT_MAX_AGE_SECONDS = 600;

// Auth is a Bearer header, not cookies, so credentials stay off.
export function configureCors(app: INestApplication) {
  const origins = app.get(AppConfig).corsOrigins;
  if (origins.length === 0) return;
  app.enableCors({
    origin: origins,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['x-request-id'],
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  });
}
