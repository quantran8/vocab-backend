import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DB, Db } from '../db/db';
import { redeemCodes } from '../db/schema';

const ONE_YEAR_DAYS = 365;
const DEFAULT_COUNT = 20;
// No 0/O/1/I/L, so a code read aloud or typed from a screenshot still matches.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const randomBlock = (length: number) => Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const newCode = () => `SYLL-1Y-${randomBlock(4)}-${randomBlock(4)}`;

/** Usage: pnpm db:seed:redeem [count] [note]. Each code is single-use and grants 365 days of Premium. */
async function main() {
  const count = Number(process.argv[2] ?? DEFAULT_COUNT);
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error('count must be an integer between 1 and 10000');
  const note = process.argv[3] ?? `seed 1y ${new Date().toISOString().slice(0, 10)}`;

  const codes = new Set<string>();
  while (codes.size < count) codes.add(newCode());

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get<Db>(DB);
  const inserted = await db
    .insert(redeemCodes)
    .values([...codes].map((code) => ({ code, durationDays: ONE_YEAR_DAYS, maxUses: 1, expiresAt: null, note })))
    .onConflictDoNothing()
    .returning({ code: redeemCodes.code });
  await app.close();

  for (const { code } of inserted) console.log(code);
  console.error(`Inserted ${inserted.length}/${count} one-year redeem codes (note: ${note})`);
}

void main();
