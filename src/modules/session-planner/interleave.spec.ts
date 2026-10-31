import { TEMPLATE } from '../../common/constants/domain';
import { pickWeighted, planNewMeanings, PlanSlot, TaskSlot } from './interleave';

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const tasks = (slots: PlanSlot[]) => slots.filter((s): s is TaskSlot => s.kind === 'task');

describe('planNewMeanings', () => {
  it('C29 C30 gives every Meaning all mandatory groups', () => {
    const slots = planNewMeanings(3, seeded(7));
    for (const m of [0, 1, 2]) {
      const mine = tasks(slots).filter((t) => t.meaningIndex === m).map((t) => t.template);
      expect(mine.filter((t) => t === TEMPLATE.select)).toHaveLength(3);
      expect(mine).toContain(TEMPLATE.recording);
      expect(mine.filter((t) => t === TEMPLATE.typing || t === TEMPLATE.flyReorder)).toHaveLength(1);
    }
  });

  it('C34 interleaves instead of grouping AAAAA/BBBBB', () => {
    for (let seed = 1; seed < 50; seed += 1) {
      const order = tasks(planNewMeanings(3, seeded(seed))).map((t) => t.meaningIndex);
      order.slice(1).forEach((value, i) => expect(value).not.toBe(order[i]));
    }
  });

  it('keeps recall after select and before recording', () => {
    const list = tasks(planNewMeanings(2, seeded(3)));
    for (const m of [0, 1]) {
      const mine = list.filter((t) => t.meaningIndex === m);
      expect(mine[2].isFirstRecall).toBe(true);
      expect(mine[3].template).toBe(TEMPLATE.recording);
    }
  });

  it('randomizes typing and flyReorder at the recall slot', () => {
    const picks = Array.from({ length: 60 }, (_, seed) => tasks(planNewMeanings(1, seeded((seed + 1) * 715_827_883)))[2].template);
    expect(new Set(picks)).toEqual(new Set([TEMPLATE.typing, TEMPLATE.flyReorder]));
  });

  it('plans nothing for zero Meanings', () => {
    expect(planNewMeanings(0, seeded(1))).toEqual([]);
  });
});

describe('pickWeighted', () => {
  it('ignores zero weights and handles empty input', () => {
    expect(pickWeighted([{ value: 'a', weight: 0 }, { value: 'b', weight: 1 }], seeded(1))).toBe('b');
    expect(pickWeighted([], seeded(1))).toBeUndefined();
  });
});
