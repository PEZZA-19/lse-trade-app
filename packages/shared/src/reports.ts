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
  /** Time at the business labour rate. */
  labourPence: number;
  /** Actual materials at cost: supplier-bill lines and hand-added material lines. */
  materialsCostPence: number;
  /** Net invoiced so far (issued invoices, ex VAT, less credit notes). */
  invoicedPence: number;
  /** quoted (or line value when not quoted) minus labour minus materials. */
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
