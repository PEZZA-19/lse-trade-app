import { describe, expect, it } from 'vitest';
import {
  formatMarkup,
  formatPence,
  formatQty,
  lineTotal,
  parsePounds,
  parseQty,
  sellFromCost,
} from '../src';

describe('sellFromCost', () => {
  it('applies the markup exactly when it divides evenly', () => {
    expect(sellFromCost(1000, 13000)).toBe(1300);
  });
  it('rounds up to the next penny, never down', () => {
    expect(sellFromCost(333, 13000)).toBe(433); // 432.9 -> 433
    expect(sellFromCost(1, 13000)).toBe(2); // 1.3 -> 2
    expect(sellFromCost(1001, 11000)).toBe(1102); // 1101.1 -> 1102
  });
  it('is identity at 1.0x', () => {
    expect(sellFromCost(4567, 10000)).toBe(4567);
  });
  it('rejects non-integers', () => {
    expect(() => sellFromCost(10.5, 13000)).toThrow(RangeError);
  });
});

describe('lineTotal', () => {
  it('multiplies fractional quantities and rounds up', () => {
    expect(lineTotal(2500, 4500)).toBe(11250); // 2.5h at £45
    expect(lineTotal(333, 100)).toBe(34); // 0.333 x £1 = 33.3p -> 34p
    expect(lineTotal(1000, 0)).toBe(0);
  });
});

describe('parseQty / formatQty', () => {
  it.each([
    ['1', 1000],
    ['2.5', 2500],
    ['0.125', 125],
    [' 12 ', 12000],
    ['-1.5', -1500],
  ])('parses %s', (input, expected) => {
    expect(parseQty(input)).toBe(expected);
  });
  it.each(['', 'abc', '1.2345', '1,5', '.5'])('rejects %j', (input) => {
    expect(parseQty(input)).toBeNull();
  });
  it('formats without trailing zeros', () => {
    expect(formatQty(2500)).toBe('2.5');
    expect(formatQty(1000)).toBe('1');
    expect(formatQty(125)).toBe('0.125');
    expect(formatQty(-1500)).toBe('-1.5');
  });
});

describe('parsePounds / formatPence', () => {
  it('parses pounds into pence', () => {
    expect(parsePounds('£1,234.56')).toBe(123456);
    expect(parsePounds('45')).toBe(4500);
    expect(parsePounds('0.5')).toBe(50);
    expect(parsePounds('12.345')).toBeNull();
    expect(parsePounds('')).toBeNull();
  });
  it('formats as GBP', () => {
    expect(formatPence(123456)).toBe('£1,234.56');
    expect(formatPence(0)).toBe('£0.00');
  });
  it('formats markups', () => {
    expect(formatMarkup(13000)).toBe('1.3');
    expect(formatMarkup(11000)).toBe('1.1');
  });
});
