import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Append-only cache: the last line for a key wins, so an interrupted run resumes where it stopped. */
export class JsonlStore<T extends { key: string }> {
  readonly rows = new Map<string, T>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as T;
      this.rows.set(row.key, row);
    }
  }

  append(rows: T[]) {
    if (rows.length === 0) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    for (const row of rows) this.rows.set(row.key, row);
  }
}

export function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Missing ${path}: run the earlier stage first`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const chunk = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
