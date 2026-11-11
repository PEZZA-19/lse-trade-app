/**
 * Money and quantity maths.
 *
 * Rules (from LSE's job sheets, and the safest choice for any business):
 * - Money is always whole pence (integers). Never floating point.
 * - Quantities are stored in thousandths ("milli-units") so 2.5 hours = 2500.
 * - Markups are basis points of a multiplier: 1.3x = 13000, 1.1x = 11000.
 * - Sell price = cost x markup, rounded UP to the penny.
 * - Line total = quantity x unit sell, rounded UP to the penny.
 */

export type Pence = number;

const MILLI = 1000;
const BP = 10000;

function assertSafeInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer, got ${n}`);
}

/** Integer division rounding up, for non-negative numerators; rounds toward +infinity for negatives too. */
function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

/** cost x markup, rounded up to the penny. 1000p at 13000bp (1.3x) -> 1300p. */
export function sellFromCost(costPence: Pence, markupBp: number): Pence {
  assertSafeInt(costPence, 'costPence');
  assertSafeInt(markupBp, 'markupBp');
  return ceilDiv(costPence * markupBp, BP);
}

/** qty (milli-units) x unit price, rounded up to the penny. */
export function lineTotal(qtyMilli: number, unitPence: Pence): Pence {
  assertSafeInt(qtyMilli, 'qtyMilli');
  assertSafeInt(unitPence, 'unitPence');
  return ceilDiv(qtyMilli * unitPence, MILLI);
}

/**
 * Parses a decimal string such as "12.5" or "0.125" into thousandths without
 * touching floating point. Returns null if the input is not a valid quantity.
 */
export function parseQty(input: string): number | null {
  const m = /^\s*(-)?(\d+)(?:\.(\d{1,3}))?\s*$/.exec(input);
  if (!m) return null;
  const [, sign, whole = '0', frac = ''] = m;
  const value = Number(whole) * MILLI + Number(frac.padEnd(3, '0'));
  if (!Number.isSafeInteger(value)) return null;
  return sign ? -value : value;
}

/** Formats thousandths as a short decimal string: 2500 -> "2.5", 1000 -> "1". */
export function formatQty(qtyMilli: number): string {
  const sign = qtyMilli < 0 ? '-' : '';
  const abs = Math.abs(qtyMilli);
  const whole = Math.floor(abs / MILLI);
  const frac = String(abs % MILLI)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parses "£1,234.56", "1234.5" or "12" into pence. Returns null if invalid. */
export function parsePounds(input: string): Pence | null {
  const cleaned = input.replace(/[£,\s]/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const [, sign, whole = '0', frac = ''] = m;
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(value)) return null;
  return sign ? -value : value;
}

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

/** 123456 -> "£1,234.56" */
export function formatPence(pence: Pence): string {
  return gbp.format(pence / 100);
}

/** 13000 -> "1.3", 11000 -> "1.1" */
export function formatMarkup(markupBp: number): string {
  return formatQty(markupBp / 10);
}
