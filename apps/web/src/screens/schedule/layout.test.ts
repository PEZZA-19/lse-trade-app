import { describe, expect, it } from 'vitest';
import { layoutDay } from './layout';

const a = (id: string, s: string, e: string) => ({
  id,
  startsAt: `2026-11-11T${s}:00.000Z`,
  endsAt: `2026-11-11T${e}:00.000Z`,
});
const cols = (items: ReturnType<typeof a>[]) =>
  Object.fromEntries(layoutDay(items).map((p) => [p.item.id, `${p.col}/${p.cols}`]));

describe('day layout', () => {
  it('gives non-overlapping appointments the full width', () => {
    expect(cols([a('x', '08:00', '09:00'), a('y', '09:00', '10:00')])).toEqual({
      x: '0/1',
      y: '0/1',
    });
  });
  it('puts overlapping ones side by side and reuses free columns', () => {
    expect(
      cols([
        a('x', '08:00', '12:00'),
        a('y', '09:00', '10:00'),
        a('z', '10:00', '11:00'),
        a('w', '13:00', '14:00'),
      ]),
    ).toEqual({ x: '0/2', y: '1/2', z: '1/2', w: '0/1' });
  });
  it('handles three at once', () => {
    expect(
      cols([a('x', '08:00', '10:00'), a('y', '08:30', '10:00'), a('z', '09:00', '09:30')]),
    ).toEqual({
      x: '0/3',
      y: '1/3',
      z: '2/3',
    });
  });
});
