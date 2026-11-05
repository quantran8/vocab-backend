import { CefrLevel } from '../../../common/constants/domain';
import { buildPlacementQuestions, estimateLevel } from './placement';

const answers = (level: CefrLevel, correct: number, total = 3) =>
  Array.from({ length: total }, (_, i) => ({ level, correct: i < correct }));

describe('estimateLevel', () => {
  it('returns the highest level with every lower level passed', () => {
    expect(estimateLevel([...answers('A1', 3), ...answers('A2', 2), ...answers('B1', 1), ...answers('B2', 3)])).toBe('A2');
  });
  it('falls back to the lowest level when nothing passes', () => {
    expect(estimateLevel(answers('A1', 0))).toBe('A1');
  });
  it('skips a level with no questions', () => {
    expect(estimateLevel([...answers('A1', 3), ...answers('B1', 3)])).toBe('B1');
  });
  it('reaches the top level', () => {
    expect(estimateLevel((['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const).flatMap((l) => answers(l, 3)))).toBe('C2');
  });
});

describe('buildPlacementQuestions', () => {
  const candidate = { meaningId: 'm1', wordId: 'w1', lemma: 'clarify', meaningText: 'làm rõ' };
  const pool = [
    { wordId: 'w1', lemma: 'clarify', meaningText: 'nghĩa khác của cùng từ' },
    { wordId: 'w2', lemma: 'other', meaningText: 'làm rõ' },
    { wordId: 'w3', lemma: 'third', meaningText: 'thứ ba' },
    { wordId: 'w4', lemma: 'fourth', meaningText: 'thứ ba' },
  ];

  it('drops same-word and same-label distractors and sends no answer key', () => {
    const [question] = buildPlacementQuestions([candidate], pool, 'vi-VN', () => 0);
    expect(question.options.map((o) => o.text).sort()).toEqual(['làm rõ', 'thứ ba']);
    expect(question.options.find((o) => o.text === 'làm rõ')!.id).toBe('w1');
    expect(question).not.toHaveProperty('evaluation');
  });
  it('skips a question with no distractor', () => {
    expect(buildPlacementQuestions([candidate], pool.slice(0, 2), 'vi-VN', () => 0)).toEqual([]);
  });
});
