import { AVATAR_KEYS, AvatarKey } from '../../../common/constants/domain';
import { addDays } from '../../../common/constants/time';
import { POLICY } from '../../../config/policy';

// Short enough that adjective_animal_NNNN never passes 20 characters. drizzle/0017 backfilled with the same lists.
const ADJECTIVES = [
  'bright', 'quick', 'happy', 'sunny', 'gentle', 'kind', 'swift', 'merry', 'lucky', 'jolly', 'bold', 'eager',
  'keen', 'noble', 'proud', 'quiet', 'witty', 'zesty', 'cheery', 'nimble', 'steady', 'polite', 'brisk', 'plucky', 'sparky', 'cozy', 'mellow',
  'dreamy', 'curious', 'humble', 'jazzy', 'fuzzy',
];
const ANIMALS = [
  'otter', 'panda', 'koala', 'tiger', 'lynx', 'heron', 'robin', 'finch', 'gecko', 'llama', 'bison', 'moose', 'eagle',
  'falcon', 'badger', 'beaver', 'rabbit', 'turtle', 'walrus', 'owl', 'fox', 'wolf', 'seal', 'crane', 'dingo', 'zebra', 'hippo', 'yak', 'lemur',
  'quokka', 'ferret', 'puffin',
];

// Matched against the normalized name. A starter list: the multilingual blocklist is an open gate (P5).
const RESERVED_EXACT = ['syll'];
const RESERVED_CONTAINS = ['syllie', 'admin', 'moderator', 'official', 'support', 'staff'];
const PROFANITY_CONTAINS = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'pussy', 'asshole', 'dickhead', 'whore', 'slut', 'nazi', 'hitler',
  'dcm', 'vcl', 'dmm', 'clmm', 'cailon', 'ditme', 'dume', 'dumay', 'oclon',
];
// Too short to match inside other words, so only a whole segment between separators counts.
const PROFANITY_SEGMENTS = ['dm', 'dit', 'lon', 'cac', 'cc', 'vl', 'loz', 'cut', 'buoi'];

const FORMAT = /^[a-z][a-z0-9_.]{2,19}$/;
const LEET: Record<string, string> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };

type Rng = () => number;
const pick = <T>(items: readonly T[], rng: Rng) => items[Math.floor(rng() * items.length)];

export const generateUsername = (rng: Rng = Math.random) =>
  `${pick(ADJECTIVES, rng)}_${pick(ANIMALS, rng)}_${String(Math.floor(rng() * 10_000)).padStart(4, '0')}`;

export const randomAvatar = (rng: Rng = Math.random): AvatarKey => pick(AVATAR_KEYS, rng);

/** Lowercase, so uniqueness is case-insensitive by construction. */
export const canonicalUsername = (input: string) => input.trim().toLowerCase();

export const normalizeForCheck = (username: string) => username.replace(/[_.]/g, '').replace(/[013457]/g, (d) => LEET[d]);

export type UsernameProblem = 'USERNAME_INVALID' | 'USERNAME_NOT_ALLOWED';

export function usernameProblem(username: string): UsernameProblem | null {
  if (!FORMAT.test(username) || username.includes('..')) return 'USERNAME_INVALID';
  const normalized = normalizeForCheck(username);
  const segments = username.split(/[_.]/).map(normalizeForCheck);
  const blocked = RESERVED_EXACT.includes(normalized)
    || [...RESERVED_CONTAINS, ...PROFANITY_CONTAINS].some((word) => normalized.includes(word))
    || segments.some((segment) => PROFANITY_SEGMENTS.includes(segment));
  return blocked ? 'USERNAME_NOT_ALLOWED' : null;
}

export interface UsernameState { usernameGenerated: boolean; usernameChangedAt: Date | null }

/** null when the learner may rename now: leaving a generated name is free, then once per window (spec §5.1). */
export function usernameChangeAvailableAt({ usernameGenerated, usernameChangedAt }: UsernameState, now: Date) {
  if (usernameGenerated || !usernameChangedAt) return null;
  const at = addDays(usernameChangedAt, POLICY.ranking.usernameChangeDays);
  return at > now ? at : null;
}
