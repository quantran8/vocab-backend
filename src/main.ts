import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createHttpAdapter } from './common/http/http-adapter';
import { AppConfig } from './config/app-config';

// Fastify binds to loopback by default, which is unreachable from outside a container.
const LISTEN_HOST = '0.0.0.0';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createHttpAdapter());
  app.enableShutdownHooks();

  const document = new DocumentBuilder().setTitle('Vocab Flow API').setVersion('0.4').addBearerAuth().build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, document));

  await app.listen(app.get(AppConfig).port, LISTEN_HOST);
}

void bootstrap();
