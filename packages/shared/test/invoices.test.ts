import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  displayStatus,
  invoiceCreate,
  invoiceNumber,
  invoiceTotals,
  lineTax,
  percentOf,
  signedLineTotal,
  statusAfterPayment,
} from '../src/invoices';

describe('invoiceNumber', () => {
  it('matches the job number, then adds -2, -3', () => {
    expect(invoiceNumber('122', 1)).toBe('122');
    expect(invoiceNumber('122', 2)).toBe('122-2');
    expect(invoiceNumber('J-0122', 3)).toBe('J-0122-3');
    expect(() => invoiceNumber('122', 0)).toThrow();
  });
});

describe('totals', () => {
  it('rounds line totals up and mirrors credits', () => {
    expect(signedLineTotal(1500, 333)).toBe(500);
    expect(signedLineTotal(1000, -333)).toBe(-333);
    expect(signedLineTotal(-1500, 333)).toBe(-500);
  });
  it('rounds tax half up per line', () => {
    expect(lineTax(1005, 500)).toBe(50); // 50.25
    expect(lineTax(1010, 500)).toBe(51); // 50.5
    expect(lineTax(-1010, 500)).toBe(-51);
  });
  it('totals lines with tax', () => {
    expect(
      invoiceTotals([
        { qtyMilli: 2000, unitPricePence: 5000, taxRateBp: 0 },
        { qtyMilli: 1000, unitPricePence: -2500, taxRateBp: 0 },
      ]),
    ).toEqual({ subtotalPence: 7500, taxPence: 0, totalPence: 7500, lineTotals: [10000, -2500] });
  });
  it('percentOf rounds to the nearest penny', () => {
    expect(percentOf(10001, 3000)).toBe(3000);
    expect(percentOf(10005, 5000)).toBe(5003);
  });
});

describe('status', () => {
  it('works out overdue from the due date, only for unpaid sent invoices', () => {
    expect(displayStatus({ status: 'sent', dueDate: '2026-11-10' }, '2026-11-11')).toBe('overdue');
    expect(displayStatus({ status: 'part_paid', dueDate: '2026-11-10' }, '2026-11-11')).toBe(
      'overdue',
    );
    expect(displayStatus({ status: 'sent', dueDate: '2026-11-11' }, '2026-11-11')).toBe('sent');
    expect(displayStatus({ status: 'paid', dueDate: '2026-01-01' }, '2026-11-11')).toBe('paid');
    expect(displayStatus({ status: 'draft', dueDate: null }, '2026-11-11')).toBe('draft');
  });
  it('part paid until the balance is cleared', () => {
    expect(statusAfterPayment(1000, 400)).toBe('part_paid');
    expect(statusAfterPayment(1000, 1000)).toBe('paid');
  });
  it('adds days across month ends', () => {
    expect(addDaysIso('2026-11-25', 14)).toBe('2026-12-09');
  });
});

describe('invoiceCreate', () => {
  it('accepts each mode and rejects 100% (use whole)', () => {
    expect(invoiceCreate.safeParse({ source: 'job' }).success).toBe(true);
    expect(
      invoiceCreate.safeParse({ source: 'quote', mode: 'deposit', amountPence: 5000 }).success,
    ).toBe(true);
    expect(
      invoiceCreate.safeParse({ source: 'quote', mode: 'percent', percentBp: 10000 }).success,
    ).toBe(false);
    expect(invoiceCreate.safeParse({ source: 'quote', mode: 'deposit' }).success).toBe(false);
  });
});
