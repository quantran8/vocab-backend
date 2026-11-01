import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DB, Db } from '../db/db';
import { appUsers } from '../db/schema';
import { seedDemoContent } from './seed-demo';

const DEMO_USERS = [['demo-a1', 'A1'], ['demo-a2', 'A2'], ['demo-b1', 'B1']] as const;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get<Db>(DB);
  await seedDemoContent(db);
  await db
    .insert(appUsers)
    .values(DEMO_USERS.map(([identitySubject, level]) => ({ identitySubject, proficiencyLevel: level })))
    .onConflictDoNothing();
  await app.close();
}

void main();
