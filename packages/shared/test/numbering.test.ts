import { describe, expect, it } from 'vitest';
import { formatDocNumber, quoteDisplayNumber, revisionLetter } from '../src';

describe('numbering', () => {
  it('formats with prefix and padding', () => {
    expect(formatDocNumber('Q-', 4, 1)).toBe('Q-0001');
    expect(formatDocNumber('Q-', 4, 12345)).toBe('Q-12345');
    expect(formatDocNumber('', 0, 122)).toBe('122');
  });
  it('letters revisions like spreadsheet columns', () => {
    expect([1, 2, 26, 27, 28, 52, 53].map(revisionLetter)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ]);
    expect(() => revisionLetter(0)).toThrow();
  });
  it('shows rev only from B onwards', () => {
    expect(quoteDisplayNumber('Q-0012', 1)).toBe('Q-0012');
    expect(quoteDisplayNumber('Q-0012', 2)).toBe('Q-0012 rev B');
  });
});
