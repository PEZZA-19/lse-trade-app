import { describe, expect, it } from 'vitest';
import {
  parseBankAmount,
  parseBankCsv,
  parseBankDate,
  splitCsv,
  suggestMatches,
  type BankMatchCandidate,
} from '../src';

describe('bank CSV basics', () => {
  it('splits quoted cells, escaped quotes, CRLF and a BOM', () => {
    expect(splitCsv('\uFEFFa,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('reads UK, ISO and written dates, and refuses impossible ones', () => {
    expect(parseBankDate('18/11/2026')).toBe('2026-11-18');
    expect(parseBankDate('01-02-26')).toBe('2026-02-01');
    expect(parseBankDate('2026-11-18')).toBe('2026-11-18');
    expect(parseBankDate('2026-11-18T09:30:00Z')).toBe('2026-11-18');
    expect(parseBankDate('18 Nov 2026')).toBe('2026-11-18');
    expect(parseBankDate('3-February-2027')).toBe('2027-02-03');
    expect(parseBankDate('31/02/2026')).toBeNull();
    expect(parseBankDate('11/31/2026')).toBeNull();
    expect(parseBankDate('Pending')).toBeNull();
  });

  it('reads amounts to pence without floating point', () => {
    expect(parseBankAmount('12.34')).toBe(1234);
    expect(parseBankAmount('-0.1')).toBe(-10);
    expect(parseBankAmount('£1,234.50')).toBe(123_450);
    expect(parseBankAmount('-£45.00')).toBe(-4500);
    expect(parseBankAmount('£-45.00')).toBe(-4500);
    expect(parseBankAmount('(20.00)')).toBe(-2000);
    expect(parseBankAmount('20.00 DR')).toBe(-2000);
    expect(parseBankAmount('20.00CR')).toBe(2000);
    expect(parseBankAmount('+5')).toBe(500);
    expect(parseBankAmount('0.29')).toBe(29); // 0.29 * 100 is 28.999… in floating point
    expect(parseBankAmount('')).toBeNull();
    expect(parseBankAmount('1.234')).toBeNull();
    expect(parseBankAmount('12,34')).toBeNull();
    expect(parseBankAmount('abc')).toBeNull();
  });
});

describe('bank statement layouts', () => {
  it('Lloyds: separate debit and credit columns', () => {
    const csv = [
      'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance',
      "18/11/2026,FPI,'30-00-00,12345678,A CUSTOMER INV-0012,,450.00,1450.00",
      "17/11/2026,DEB,'30-00-00,12345678,CEF GUERNSEY,120.50,,1000.00",
    ].join('\n');
    const r = parseBankCsv(csv);
    expect(r.problems).toEqual([]);
    expect(r.columns).toBe('Date, Description, Paid in, Paid out, Balance');
    expect(r.rows.map((x) => [x.date, x.description, x.amountPence, x.balancePence])).toEqual([
      ['2026-11-18', 'A CUSTOMER INV-0012', 45_000, 145_000],
      ['2026-11-17', 'CEF GUERNSEY', -12_050, 100_000],
    ]);
  });

  it('Nationwide: notes above the headings, £ signs, paid out before paid in', () => {
    const csv = [
      '"Account Name:","FlexDirect ****1234"',
      '"Account Balance:","£1,000.00"',
      '',
      '"Date","Transaction type","Description","Paid out","Paid in","Balance"',
      '"03 Nov 2026","Visa purchase","FUEL STATION","£60.00","","£940.00"',
      '"04 Nov 2026","Bank credit","SMITH J","","£1,200.00","£2,140.00"',
    ].join('\n');
    const r = parseBankCsv(csv);
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => [x.line, x.date, x.amountPence])).toEqual([
      [5, '2026-11-03', -6000],
      [6, '2026-11-04', 120_000],
    ]);
  });

  it('Starling and Monzo: signed Amount, Counter Party / Name as the description', () => {
    const starling = parseBankCsv(
      'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes\n' +
        '18/11/2026,Condor Ferries,BOOKING 55,CARD,-86.50,913.50,TRAVEL,\n',
    );
    expect(starling.rows[0]).toMatchObject({
      description: 'Condor Ferries',
      reference: 'BOOKING 55',
      amountPence: -8650,
      balancePence: 91_350,
    });
    const monzo = parseBankCsv(
      'Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description\n' +
        'tx_1,18/11/2026,09:12:00,Card payment,Screwfix,,shopping,-23.99,GBP,-23.99,GBP,,,,SCREWFIX DIRECT\n',
    );
    // "Description" outranks "Name" when both are there.
    expect(monzo.rows[0]).toMatchObject({ description: 'SCREWFIX DIRECT', amountPence: -2399 });
  });

  it('Barclays: Memo, and HSBC with no headings at all', () => {
    const barclays = parseBankCsv(
      'Number,Date,Account,Amount,Subcategory,Memo\n,18/11/2026,20-00-00 1234,-5.00,PAYMENT,"COSTA    COFFEE"\n',
    );
    expect(barclays.rows[0]).toMatchObject({ description: 'COSTA COFFEE', amountPence: -500 });
    const hsbc = parseBankCsv('18/11/2026,PAYPAL PAYMENT,-12.00\n17/11/2026,J BLOGGS,"1,000.00"\n');
    expect(hsbc.rows.map((x) => x.amountPence)).toEqual([-1200, 100_000]);
    expect(hsbc.columns).toBe('Date, Description, Amount');
  });

  it('lists rows it can’t read, skips blank and zero rows, never throws', () => {
    const r = parseBankCsv(
      'Date,Description,Amount\n18/11/2026,OK,1.00\nPending,CARD,-2.00\n18/11/2026,BAD,twelve\n\n18/11/2026,ZERO,0.00\n',
    );
    expect(r.rows).toHaveLength(1);
    expect(r.problems).toEqual([
      { line: 3, message: 'No date we can read (“Pending”).' },
      { line: 4, message: 'No amount we can read.' },
    ]);
    expect(parseBankCsv('hello\nworld').problems[0]!.message).toMatch(
      /doesn’t look like a bank statement/,
    );
    expect(parseBankCsv('').rows).toEqual([]);
  });

  it('a row with both paid in and paid out filled is a problem, not a guess', () => {
    const r = parseBankCsv('Date,Description,Paid in,Paid out\n18/11/2026,ODD,5.00,6.00\n');
    expect(r.rows).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });

  it('fingerprints: identical rows on one day stay separate; re-reading the file gives the same ones', () => {
    const csv =
      'Date,Description,Amount\n18/11/2026,COSTA,-3.20\n18/11/2026,Costa,-3.20\n18/11/2026,COSTA,-3.20\n';
    const a = parseBankCsv(csv).rows.map((x) => x.fingerprint);
    expect(new Set(a).size).toBe(3);
    expect(parseBankCsv(csv).rows.map((x) => x.fingerprint)).toEqual(a);
    // An overlapping later statement that repeats the first coffee gives the same fingerprint for it.
    const later = parseBankCsv(
      'Date,Description,Amount\n18/11/2026,COSTA,-3.20\n19/11/2026,COSTA,-3.20\n',
    );
    expect(later.rows[0]!.fingerprint).toBe(a[0]);
  });
});

describe('bank matching suggestions', () => {
  const cand = (over: Partial<BankMatchCandidate>): BankMatchCandidate => ({
    kind: 'payment',
    id: 'p1',
    date: '2026-11-16',
    amountPence: 45_000,
    label: 'Payment for INV-0012 · Ann Example',
    words: ['INV-0012', 'Ann Example'],
    ...over,
  });
  const line = {
    date: '2026-11-18',
    amountPence: 45_000,
    description: 'A EXAMPLE 0012',
    reference: '',
  };

  it('only the same amount, in the same direction, within 10 days', () => {
    expect(suggestMatches(line, [cand({ amountPence: 45_001 })])).toEqual([]);
    expect(suggestMatches(line, [cand({ amountPence: -45_000 })])).toEqual([]);
    expect(suggestMatches(line, [cand({ date: '2026-11-01' })])).toEqual([]);
    expect(suggestMatches(line, [cand({ date: '2026-11-28' })])).toHaveLength(1);
  });

  it('a name or number on the line makes it strong; closer dates rank first', () => {
    const [s] = suggestMatches(line, [cand({})]);
    expect(s).toMatchObject({
      strong: true,
      reason: 'Same amount · 2 days apart · mentions INV-0012',
    });
    const plain = suggestMatches({ ...line, description: 'FASTER PAYMENT' }, [cand({})]);
    expect(plain[0]).toMatchObject({ strong: false, reason: 'Same amount · 2 days apart' });
    const two = suggestMatches({ ...line, description: 'FASTER PAYMENT' }, [
      cand({ id: 'far', date: '2026-11-10' }),
      cand({ id: 'near', date: '2026-11-18' }),
    ]);
    expect(two.map((x) => x.id)).toEqual(['near', 'far']);
    // A surname alone is enough.
    expect(
      suggestMatches({ ...line, description: 'EXAMPLE A' }, [cand({ words: ['Ann Example'] })])[0]!
        .strong,
    ).toBe(true);
  });

  it('money out matches supplier payments and expenses', () => {
    const out = {
      date: '2026-11-17',
      amountPence: -12_050,
      description: 'CEF GUERNSEY',
      reference: '',
    };
    const r = suggestMatches(out, [
      cand({ kind: 'bill_payment', id: 'b1', amountPence: -12_050, words: ['CEF', 'GUR/1'] }),
      cand({ kind: 'expense', id: 'e1', amountPence: -12_050, words: ['Island fuel'] }),
    ]);
    expect(r.map((x) => x.id)).toEqual(['b1', 'e1']);
    expect(r[0]!.strong).toBe(true);
    expect(r[1]!.strong).toBe(false);
  });
});
