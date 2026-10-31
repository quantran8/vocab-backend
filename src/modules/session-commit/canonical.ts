import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export const canonicalHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
