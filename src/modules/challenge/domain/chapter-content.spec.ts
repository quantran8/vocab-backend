import { describe, expect, it } from 'vitest';
import { Candidate, composeChapter, normalizeKey, pickDistinct, repairSlots, toCandidate } from './chapter-content';

const cand = (id: string, lemma = `w-${id}`, gloss = `g-${id}`) => toCandidate({ meaningId: id, lemma, gloss })!;
const many = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => cand(`${prefix}${i}`));

describe('chapter content', () => {
  it('normalizes case, width and spacing', () => {
    expect(normalizeKey('  Hoàn   TRẢ ')).toBe('hoàn trả');
    expect(toCandidate({ meaningId: 'x', lemma: ' ', gloss: 'g' })).toBeNull();
  });

  it('keeps the earliest Meaning when two share a word or a gloss', () => {
    const list: Candidate[] = [cand('a', 'bank', 'ngân hàng'), cand('b', 'Bank', 'bờ sông'), cand('c', 'shore', 'Ngân  hàng'), cand('d')];
    expect(pickDistinct(list, 10).map((c) => c.meaningId)).toEqual(['a', 'd']);
  });

  it('12 raw but 11 distinct cannot open a chapter', () => {
    const raw = [...many(11), cand('dup', 'w-m0', 'other')];
    expect(composeChapter({ chapterId: 'c', coreCount: 12, reviewCount: 3, unallocated: raw, priorCores: [] })).toBeNull();
  });

  it('adds up to 3 review Meanings that collide with no core word or gloss', () => {
    const prior = [cand('p1'), cand('p2', 'w-m0', 'x'), cand('p3'), cand('p4'), cand('p5')];
    const slots = composeChapter({ chapterId: 'c', coreCount: 12, reviewCount: 3, unallocated: many(20), priorCores: prior })!;
    const review = slots.filter((s) => s.role === 'review');
    expect(slots.filter((s) => s.role === 'core').map((s) => s.meaningId)).toEqual(many(12).map((c) => c.meaningId));
    expect(review).toHaveLength(3);
    expect(review.map((s) => s.meaningId)).not.toContain('p2');
    expect(review.map((s) => s.sortIndex)).toEqual([0, 1, 2]);
  });

  it('repair refills only invalid slots, at the same index', () => {
    const slots = composeChapter({ chapterId: 'c', coreCount: 12, reviewCount: 0, unallocated: many(12), priorCores: [] })!
      .map((s) => ({ ...s, id: s.meaningId, valid: s.meaningId !== 'm4' }));
    const repair = repairSlots({ chapterId: 'c', slots, unallocated: [cand('n1', 'w-m1', 'dup'), cand('n2')], priorCores: [] })!;
    expect(repair.retired.map((s) => s.meaningId)).toEqual(['m4']);
    expect(repair.added).toMatchObject([{ meaningId: 'n2', role: 'core', sortIndex: 4 }]);
    expect(repairSlots({ chapterId: 'c', slots, unallocated: [], priorCores: [] })).toBeNull();
  });
});
