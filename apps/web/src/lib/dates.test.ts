import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatElapsed,
  fromInputs,
  monthGrid,
  snap,
  startOfWeek,
  toDateInput,
  toTimeInput,
} from './dates';

describe('calendar maths', () => {
  it('weeks start on Monday', () => {
    expect(toDateInput(startOfWeek(new Date(2026, 10, 11)))).toBe('2026-11-09'); // Wed → Mon
    expect(toDateInput(startOfWeek(new Date(2026, 10, 15)))).toBe('2026-11-09'); // Sun → Mon
    expect(toDateInput(startOfWeek(new Date(2026, 10, 16)))).toBe('2026-11-16'); // Mon
  });
  it('month grid is 6 weeks from the Monday on or before the 1st', () => {
    const g = monthGrid(new Date(2026, 10, 20));
    expect(g).toHaveLength(42);
    expect(toDateInput(g[0]!)).toBe('2026-10-26');
    expect(toDateInput(g[41]!)).toBe('2026-12-06');
  });
  it('adding days keeps the wall-clock time across the clocks changing', () => {
    const d = addDays(new Date(2026, 2, 28, 9, 0), 1); // BST starts 29 March
    expect(toTimeInput(d)).toBe('09:00');
  });
  it('round-trips date and time inputs', () => {
    const d = fromInputs('2026-11-11', '08:30')!;
    expect(toDateInput(d)).toBe('2026-11-11');
    expect(toTimeInput(d)).toBe('08:30');
    expect(fromInputs('11/11/2026', '8:30')).toBeNull();
  });
  it('snaps to 15 minutes and formats the timer', () => {
    expect(snap(7)).toBe(0);
    expect(snap(8)).toBe(15);
    expect(snap(52)).toBe(45);
    expect(formatElapsed(3_909_000)).toBe('1:05:09');
    expect(formatElapsed(-5)).toBe('0:00:00');
  });
});
