import { z } from 'zod';

/** A reporting period: inclusive calendar dates (YYYY-MM-DD) in the business's own time. */
export const reportQuery = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  })
  .refine((q) => q.from <= q.to, {
    message: 'The start must be on or before the end',
    path: ['to'],
  });
export type ReportQuery = z.infer<typeof reportQuery>;

export interface MoneyReportDto {
  /** Payments received in the period (by paid-on date). */
  inPence: number;
  paymentCount: number;
  /** Invoices issued in the period (gross, inc. VAT) less credit notes approved in the period. */
  invoicedPence: number;
  /** Applied supplier bills dated in the period, less supplier credit notes. */
  billsPence: number;
  /** Owed right now on issued invoices, regardless of period. */
  owedPence: number;
  overduePence: number;
  owedCount: number;
  overdueCount: number;
}

export interface JobProfitDto {
  jobId: string;
  number: string;
  title: string;
  customerName: string;
  /** The job's stage name, e.g. In Progress. */
  stage: string;
  /** Net (ex VAT) value of the lines that came from the accepted quote; null when there was no quote. */
  quotedPence: number | null;
  /** Net value of the job's lines now (quote plus anything added). */
  lineValuePence: number;
  minutes: number;
  /** Time at each person's cost rate (the labour rate for anyone without one). */
  labourPence: number;
  /** Actual materials at cost: supplier-bill lines and hand-added material lines. */
  materialsCostPence: number;
  /** Net invoiced so far (issued invoices, ex VAT, less credit notes). */
  invoicedPence: number;
  /** Revenue: the quote (ex VAT), or the job lines when it wasn't quoted. */
  revenuePence: number;
  /** The same time at the charge-out rate: what it would bill at. */
  chargeOutPence: number;
  /** People with time here who have no cost rate (their time is costed at the labour rate). */
  missingCostRates: number;
  /** Revenue minus labour at cost minus materials at cost. */
  profitPence: number;
}

export interface TimeRowDto {
  id: string;
  name: string;
  minutes: number;
}

export interface TimeReportDto {
  totalMinutes: number;
  byPerson: TimeRowDto[];
  byJob: (TimeRowDto & { number: string; byPerson: TimeRowDto[] })[];
}

export interface ReportsDto {
  from: string;
  to: string;
  labourRatePence: number;
  /** People with time who have their own cost rate / people with time. */
  costRates: { set: number; people: number };
  money: MoneyReportDto;
  jobs: JobProfitDto[];
  time: TimeReportDto;
}

/** Profit as a share of the price, in basis points; null when there is no price to compare. */
export function marginBp(j: Pick<JobProfitDto, 'quotedPence' | 'lineValuePence' | 'profitPence'>) {
  const price = j.quotedPence ?? j.lineValuePence;
  return price > 0 ? Math.round((j.profitPence * 10000) / price) : null;
}

/** Profit from the parts: the quote is the price when there is one, else the job lines. */
export function jobProfit(p: {
  quotedPence: number | null;
  lineValuePence: number;
  labourPence: number;
  materialsCostPence: number;
}) {
  return (p.quotedPence ?? p.lineValuePence) - p.labourPence - p.materialsCostPence;
}

/** Labour value of minutes at a pence-per-hour rate, rounded half up. */
export const labourValue = (minutes: number, ratePence: number) =>
  Math.floor((minutes * ratePence + 30) / 60);

const pounds = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2));
const hours = (m: number) => (m / 60).toFixed(2);
/** CSV cell: quoted when needed; a leading = + - @ is neutralised so spreadsheets never run it. */
export function csvCell(v: string | number | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (...cells: (string | number | null)[]) => cells.map(csvCell).join(',');

/** The reports as one CSV (sections separated by a blank line), for a spreadsheet or the accountant. */
export function reportsCsv(r: ReportsDto): string {
  const m = r.money;
  const lines = [
    row('Report', 'From', 'To'),
    row('Little Sark Electric reports', r.from, r.to),
    '',
    row('Money', 'Amount (£)', 'Count'),
    row('Money in', pounds(m.inPence), m.paymentCount),
    row('Invoiced less credit notes', pounds(m.invoicedPence), null),
    row('Supplier bills applied', pounds(m.billsPence), null),
    row('Owed now', pounds(m.owedPence), m.owedCount),
    row('Overdue', pounds(m.overduePence), m.overdueCount),
    '',
    row(
      'Job',
      'Title',
      'Customer',
      'Stage',
      'Revenue (£)',
      'Quoted (£)',
      'Job lines (£)',
      'Hours',
      'Charge-out value (£)',
      'Labour at cost (£)',
      'Materials cost (£)',
      'Invoiced (£)',
      'Profit (£)',
      'Margin %',
    ),
    ...r.jobs.map((j) => {
      const bp = marginBp(j);
      return row(
        j.number,
        j.title,
        j.customerName,
        j.stage,
        pounds(j.revenuePence),
        pounds(j.quotedPence),
        pounds(j.lineValuePence),
        hours(j.minutes),
        pounds(j.chargeOutPence),
        pounds(j.labourPence),
        pounds(j.materialsCostPence),
        pounds(j.invoicedPence),
        pounds(j.profitPence),
        bp === null ? null : (bp / 100).toFixed(1),
      );
    }),
    '',
    row('Person', 'Hours'),
    ...r.time.byPerson.map((p) => row(p.name, hours(p.minutes))),
    '',
    row('Job', 'Title', 'Person', 'Hours'),
    ...r.time.byJob.flatMap((j) =>
      j.byPerson.map((p) => row(j.number, j.name, p.name, hours(p.minutes))),
    ),
  ];
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------ periods ------------------------------ */

export type ReportPeriod = 'month' | 'last' | 'year';
export interface YearSetting {
  /** MM-DD the reporting year starts on. */
  yearStart: string;
  /** YYYY-MM-DD from which yearStart applies; before it, "This Year" is the calendar year. */
  yearEffectiveFrom: string;
}
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * "This Year" to date. Before the effective date the original rule applies unchanged (1 Jan to
 * today). From the effective date the year starts on the latest yearStart on or before today,
 * but never earlier than the effective date, so the first year after a change is a short one
 * and no earlier report moves.
 */
export function thisYearRange(today: string, s: YearSetting): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  if (today < s.yearEffectiveFrom) return { from: `${y}-01-01`, to: today };
  const thisYears = `${y}-${s.yearStart}`;
  const start = thisYears <= today ? thisYears : `${y - 1}-${s.yearStart}`;
  return { from: start < s.yearEffectiveFrom ? s.yearEffectiveFrom : start, to: today };
}

/** The Reports period picker, in the business's own calendar dates (today = YYYY-MM-DD there). */
export function reportPeriodRange(
  p: ReportPeriod,
  today: string,
  s: YearSetting,
): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  if (p === 'year') return thisYearRange(today, s);
  if (p === 'month') return { from: `${y}-${pad2(m)}-01`, to: today };
  const ly = m === 1 ? y - 1 : y;
  const lm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
  return { from: `${ly}-${pad2(lm)}-01`, to: `${ly}-${pad2(lm)}-${pad2(last)}` };
}

/* ----------------------------- cost rates ---------------------------- */

/** Total cost per hour: base (wages) plus tax/on-costs. */
export const costRate = (baseCostPence: number, onCostPence: number) => baseCostPence + onCostPence;

/** Cost of one person's minutes on a job: their cost rate, else the labour rate (rounded half up). */
export function personLabourCost(
  minutes: number,
  costRatePence: number | null,
  labourRatePence: number,
) {
  return labourValue(minutes, costRatePence ?? labourRatePence);
}
