import { CHALLENGE_ROLE, ChallengeRole } from '../../../common/constants/domain';
import { seededOrder, SlotContent } from './match-madness';

/** Two strings that render the same on a tile must share a key. */
export const normalizeKey = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export interface Candidate extends SlotContent { wordKey: string; glossKey: string }
export interface Slot extends Candidate { role: ChallengeRole; sortIndex: number }

export const toCandidate = (c: SlotContent): Candidate | null => {
  const wordKey = normalizeKey(c.lemma);
  const glossKey = normalizeKey(c.gloss);
  return wordKey && glossKey ? { ...c, lemma: c.lemma.trim(), gloss: c.gloss.trim(), wordKey, glossKey } : null;
};

/** Keys already on the board, so no two tiles of one chapter read the same. */
export class TakenKeys {
  private readonly words = new Set<string>();
  private readonly glosses = new Set<string>();
  private readonly meanings = new Set<string>();

  constructor(slots: Candidate[] = []) { slots.forEach((s) => this.add(s)); }

  fits(c: Candidate) { return !this.meanings.has(c.meaningId) && !this.words.has(c.wordKey) && !this.glosses.has(c.glossKey); }

  add(c: Candidate) {
    this.meanings.add(c.meaningId);
    this.words.add(c.wordKey);
    this.glosses.add(c.glossKey);
  }
}

/** Greedy in the given order (learned_at, meaning_id): the earliest Meaning keeps a shared word or gloss. */
export function pickDistinct(candidates: Candidate[], count: number, taken = new TakenKeys()) {
  const picked: Candidate[] = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (!taken.fits(c)) continue;
    taken.add(c);
    picked.push(c);
  }
  return picked;
}

/** Review spreads over every earlier chapter, in an order fixed by the chapter id. */
export const pickReview = (chapterId: string, priorCores: Candidate[], count: number, taken: TakenKeys) =>
  pickDistinct(seededOrder(chapterId, 'review', priorCores, (c) => c.meaningId), count, taken);

/** A fresh chapter: core first, then review that collides with none of it. */
export function composeChapter(input: {
  chapterId: string; coreCount: number; reviewCount: number; unallocated: Candidate[]; priorCores: Candidate[];
}): Slot[] | null {
  const taken = new TakenKeys();
  const core = pickDistinct(input.unallocated, input.coreCount, taken);
  if (core.length < input.coreCount) return null;
  const review = pickReview(input.chapterId, input.priorCores, input.reviewCount, taken);
  return [
    ...core.map((c, i) => ({ ...c, role: CHALLENGE_ROLE.CORE, sortIndex: i })),
    ...review.map((c, i) => ({ ...c, role: CHALLENGE_ROLE.REVIEW, sortIndex: i })),
  ];
}

/**
 * Refills only the invalid slots, keeping each slot's index. Returns null when the core cannot be refilled;
 * a missing review slot is only dropped, since review is optional.
 */
export function repairSlots<S extends Slot & { valid: boolean }>(input: {
  chapterId: string; slots: S[]; unallocated: Candidate[]; priorCores: Candidate[];
}) {
  const kept = input.slots.filter((s) => s.valid);
  const taken = new TakenKeys(kept);
  const freed = (role: ChallengeRole) => input.slots.filter((s) => !s.valid && s.role === role).map((s) => s.sortIndex);
  const coreSlots = freed(CHALLENGE_ROLE.CORE);
  const core = pickDistinct(input.unallocated, coreSlots.length, taken);
  if (core.length < coreSlots.length) return null;
  const reviewSlots = freed(CHALLENGE_ROLE.REVIEW);
  const review = pickReview(input.chapterId, input.priorCores, reviewSlots.length, taken);
  const added: Slot[] = [
    ...core.map((c, i) => ({ ...c, role: CHALLENGE_ROLE.CORE, sortIndex: coreSlots[i] })),
    ...review.map((c, i) => ({ ...c, role: CHALLENGE_ROLE.REVIEW, sortIndex: reviewSlots[i] })),
  ];
  return { retired: input.slots.filter((s) => !s.valid), added };
}
