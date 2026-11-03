import { Injectable } from '@nestjs/common';
import { MS_PER_SECOND } from '../constants/time';

const TTL_MS = 300 * MS_PER_SECOND;
const MAX_ENTRIES = 10_000;

/** Token subject to app user id; saves the provisioning round trip on every request after the first. */
@Injectable()
export class UserIdCache {
  private readonly entries = new Map<string, { id: string; expiresAt: number }>();

  get(subject: string) {
    const entry = this.entries.get(subject);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(subject);
      return undefined;
    }
    return entry.id;
  }

  set(subject: string, id: string) {
    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
    this.entries.set(subject, { id, expiresAt: Date.now() + TTL_MS });
  }

  delete(subject: string) {
    this.entries.delete(subject);
  }

  clear() {
    this.entries.clear();
  }
}
