import { describe, expect, it } from 'vitest';
import {
  costRate,
  csvCell,
  jobProfit,
  labourValue,
  personLabourCost,
  reportPeriodRange,
  reportsCsv,
  thisYearRange,
  validMonthDay,
  type ReportsDto,
} from '../src';

const LSE = { yearStart: '01-01', yearEffectiveFrom: '2027-01-01' };
const TAX_YEAR = { yearStart: '04-06', yearEffectiveFrom: '2027-01-01' };

describe('reporting year', () => {
  it('keeps the original rule before 1 Jan 2027 (calendar year to date)', () => {
    expect(thisYearRange('2026-06-15', LSE)).toEqual({ from: '2026-01-01', to: '2026-06-15' });
    expect(thisYearRange('2026-12-31', LSE)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    // Even for a tenant who chose a different year start: before its effective date nothing moves.
    expect(thisYearRange('2026-12-31', TAX_YEAR)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('switches on 1 Jan 2027: calendar years from then on', () => {
    expect(thisYearRange('2027-01-01', LSE)).toEqual({ from: '2027-01-01', to: '2027-01-01' });
    expect(thisYearRange('2027-08-20', LSE)).toEqual({ from: '2027-01-01', to: '2027-08-20' });
    expect(thisYearRange('2028-01-01', LSE)).toEqual({ from: '2028-01-01', to: '2028-01-01' });
  });

  it('another tenant’s year start: first year is short (from the effective date), then normal', () => {
    expect(thisYearRange('2027-03-01', TAX_YEAR)).toEqual({ from: '2027-01-01', to: '2027-03-01' });
    expect(thisYearRange('2027-04-05', TAX_YEAR)).toEqual({ from: '2027-01-01', to: '2027-04-05' });
    expect(thisYearRange('2027-04-06', TAX_YEAR)).toEqual({ from: '2027-04-06', to: '2027-04-06' });
    expect(thisYearRange('2028-02-01', TAX_YEAR)).toEqual({ from: '2027-04-06', to: '2028-02-01' });
  });

  it('month and last month across the year boundary', () => {
    expect(reportPeriodRange('last', '2027-01-01', LSE)).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(reportPeriodRange('month', '2027-01-01', LSE)).toEqual({
      from: '2027-01-01',
      to: '2027-01-01',
    });
    expect(reportPeriodRange('last', '2026-03-10', LSE)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('year start must exist every year', () => {
    expect(validMonthDay('04-06')).toBe(true);
    expect(validMonthDay('02-29')).toBe(false);
    expect(validMonthDay('04-31')).toBe(false);
  });
});

describe('cost-rate profit', () => {
  it('total cost per hour is base plus the tax/on-cost part', () => {
    expect(costRate(2000, 455)).toBe(2455);
    expect(costRate(2000, 0)).toBe(2000);
  });

  it('rounds each person’s labour cost half up to the penny', () => {
    expect(personLabourCost(90, 2455, 4500)).toBe(3683); // 3682.5 → 3683
    expect(personLabourCost(37, 2455, 4500)).toBe(1514); // 1513.92 → 1514
    expect(personLabourCost(30, 2001, 4500)).toBe(1001); // 1000.5 → 1001
    expect(personLabourCost(1, 2999, 4500)).toBe(50); // 49.98 → 50
  });

  it('a person with no cost rate is costed at the labour (charge-out) rate', () => {
    expect(personLabourCost(30, null, 4500)).toBe(2250);
    expect(personLabourCost(30, null, 4500)).toBe(labourValue(30, 4500));
  });

  it('profit = revenue − labour at cost − materials at cost', () => {
    const labour = personLabourCost(90, 2455, 4500) + personLabourCost(30, null, 4500);
    expect(labour).toBe(5933);
    expect(
      jobProfit({
        quotedPence: 20000,
        lineValuePence: 99999,
        labourPence: labour,
        materialsCostPence: 2000,
      }),
    ).toBe(20000 - 5933 - 2000);
    // Not quoted: the job lines are the revenue.
    expect(
      jobProfit({
        quotedPence: null,
        lineValuePence: 8000,
        labourPence: labour,
        materialsCostPence: 0,
      }),
    ).toBe(8000 - 5933);
  });
});

describe('reports CSV', () => {
  const r: ReportsDto = {
    from: '2027-01-01',
    to: '2027-01-31',
    labourRatePence: 4500,
    costRates: { set: 1, people: 2 },
    money: {
      inPence: 12345,
      paymentCount: 2,
      invoicedPence: 20000,
      billsPence: 5000,
      owedPence: 7655,
      overduePence: 0,
      owedCount: 1,
      overdueCount: 0,
    },
    jobs: [
      {
        jobId: 'j',
        number: '122',
        title: 'Barn, "big" rewire',
        customerName: '=HYPERLINK("x")',
        stage: 'In Progress',
        quotedPence: 20000,
        lineValuePence: 20000,
        minutes: 120,
        labourPence: 5933,
        materialsCostPence: 2000,
        invoicedPence: 0,
        revenuePence: 20000,
        chargeOutPence: 9000,
        missingCostRates: 1,
        profitPence: -1500,
      },
    ],
    time: { totalMinutes: 120, byPerson: [{ id: 'u', name: 'Joe', minutes: 120 }], byJob: [] },
  };

  it('quotes awkward text, neutralises formulas, keeps negative numbers as numbers', () => {
    const csv = reportsCsv(r);
    expect(csv).toContain('"Barn, ""big"" rewire"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(',200.00,200.00,200.00,2.00,90.00,59.33,20.00,0.00,-15.00,-7.5');
    expect(csv).toContain('Money in,123.45,2');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csvCell('-5.00')).toBe('-5.00');
    expect(csvCell('-x')).toBe("'-x");
  });
});
