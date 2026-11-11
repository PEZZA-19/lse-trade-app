import { describe, expect, it } from 'vitest';
import { readiness, settingsUpdate } from '../src/settings';

const complete = {
  name: 'Demo Electric',
  address: '1 Demo Lane, Sark',
  phone: '01481 000000',
  email: null,
  labourRatePence: 4500,
  bankAccountName: 'Demo Electric',
  bankSortCode: '12-34-56',
  bankAccountNumber: '12345678',
};

describe('readiness', () => {
  it('is ready when everything is filled in', () => {
    const r = readiness(complete);
    expect(r.quote.ready).toBe(true);
    expect(r.invoice.ready).toBe(true);
  });
  it('lists what a quote needs, in plain English', () => {
    const r = readiness({ ...complete, address: ' ', phone: null, labourRatePence: 0 });
    expect(r.quote.ready).toBe(false);
    expect(r.quote.missing.map((m) => m.label)).toEqual([
      'Business address',
      'Phone or email',
      'Labour rate',
    ]);
  });
  it('email alone is enough contact detail', () => {
    expect(readiness({ ...complete, phone: null, email: 'a@b.example' }).quote.ready).toBe(true);
  });
  it('invoices also need bank details, quotes do not', () => {
    const r = readiness({ ...complete, bankSortCode: null });
    expect(r.quote.ready).toBe(true);
    expect(r.invoice.missing.map((m) => m.field)).toEqual(['bankSortCode']);
  });
});

describe('settingsUpdate', () => {
  it('normalises sort codes and blanks', () => {
    const v = settingsUpdate.parse({ bankSortCode: '12 34 56', bankAccountNumber: '', email: '' });
    expect(v).toMatchObject({ bankSortCode: '12-34-56', bankAccountNumber: null, email: null });
  });
  it('rejects bad bank details and digit prefixes', () => {
    expect(settingsUpdate.safeParse({ bankSortCode: '1234' }).success).toBe(false);
    expect(settingsUpdate.safeParse({ bankAccountNumber: '1234567x' }).success).toBe(false);
    expect(
      settingsUpdate.safeParse({
        sequences: [{ kind: 'job', prefix: 'J1', padding: 0, nextValue: 5 }],
      }).success,
    ).toBe(false);
  });
  it('tax rate defaults are the caller’s job but bounds are enforced', () => {
    expect(settingsUpdate.safeParse({ taxRateBp: 0 }).success).toBe(true);
    expect(settingsUpdate.safeParse({ taxRateBp: -1 }).success).toBe(false);
  });
});
