import {
  jobProfit,
  labourValue,
  type BillSummaryDto,
  type InvoiceDetailDto,
  type InvoiceSummaryDto,
  type JobDetailDto,
  type JobProfitDto,
  type ReportsDto,
  type TimeReportDto,
} from '@lse/shared';

export interface ReportsCtx {
  call: (method: string, path: string) => unknown;
  jobIds: string[];
  timesheets: { jobId: string; startedAt: string; endedAt: string }[];
  user: { id: string; name: string };
  labourRatePence: number;
  today: string;
}

const minutesOf = (s: { startedAt: string; endedAt: string }) =>
  Math.floor((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60_000);
const localDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date(iso));

/** The demo's reports, built from the same mock endpoints the screens use (mirrors the server). */
export function demoReports(c: ReportsCtx, from: string, to: string): ReportsDto {
  const inRange = (d: string | null) => !!d && d >= from && d <= to;
  const invoices = (c.call('GET', '/invoices?filter=all') as InvoiceSummaryDto[]).filter(
    (i) => i.status !== 'draft',
  );
  const details = invoices.map((i) => c.call('GET', `/invoices/${i.id}`) as InvoiceDetailDto);
  const payments = details.flatMap((d) => d.payments).filter((p) => inRange(p.paidOn));
  const credits = details
    .flatMap((d) => d.creditNotes)
    .filter((n) => n.status === 'approved' && inRange(n.issueDate));
  const bills = (c.call('GET', '/supplier-bills?status=applied') as BillSummaryDto[]).filter((b) =>
    inRange(b.billDate),
  );
  const open = invoices.filter((i) => i.status !== 'paid' && i.balancePence > 0);
  const late = open.filter(
    (i) => (i.status === 'sent' || i.status === 'part_paid') && !!i.dueDate && i.dueDate < c.today,
  );
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

  const jobs: JobProfitDto[] = c.jobIds
    .map((id) => c.call('GET', `/jobs/${id}`) as JobDetailDto)
    .filter((j) => j.stage.systemKey !== 'cancelled')
    .map((j) => {
      const quoteLines = j.lines.filter((l) => l.source === 'quote');
      const minutes = sum(
        c.timesheets.filter((s) => s.jobId === j.id),
        minutesOf,
      );
      const parts = {
        quotedPence: quoteLines.length ? sum(quoteLines, (l) => l.totalPence) : null,
        lineValuePence: sum(j.lines, (l) => l.totalPence),
        labourPence: labourValue(minutes, c.labourRatePence),
        materialsCostPence: sum(
          j.lines.filter((l) => l.kind === 'material' && l.source !== 'quote'),
          (l) => Math.round(((l.unitCostPence ?? 0) * l.qtyMilli) / 1000),
        ),
      };
      return {
        jobId: j.id,
        number: j.number,
        title: j.title,
        customerName: j.customerName,
        stage: j.stage.name,
        ...parts,
        minutes,
        invoicedPence: sum(
          details.filter((d) => d.jobId === j.id),
          (d) => d.subtotalPence,
        ),
        profitPence: jobProfit(parts),
      };
    })
    .filter((j) => j.quotedPence !== null || j.minutes > 0 || j.materialsCostPence > 0);

  const sheets = c.timesheets.filter((s) => inRange(localDate(s.startedAt)));
  const byJob = new Map<string, TimeReportDto['byJob'][number]>();
  for (const s of sheets) {
    const m = minutesOf(s);
    const j = jobs.find((x) => x.jobId === s.jobId);
    const row = byJob.get(s.jobId) ?? {
      id: s.jobId,
      name: j?.title ?? 'Job',
      number: j?.number ?? '',
      minutes: 0,
      byPerson: [{ ...c.user, minutes: 0 }],
    };
    row.minutes += m;
    row.byPerson[0]!.minutes += m;
    byJob.set(s.jobId, row);
  }
  const total = sum(sheets, minutesOf);
  return {
    from,
    to,
    labourRatePence: c.labourRatePence,
    money: {
      inPence: sum(payments, (p) => p.amountPence),
      paymentCount: payments.length,
      invoicedPence:
        sum(
          invoices.filter((i) => inRange(i.issueDate)),
          (i) => i.totalPence,
        ) - sum(credits, (n) => n.amountPence),
      billsPence: sum(bills, (b) => (b.kind === 'credit_note' ? -b.totalPence : b.totalPence)),
      owedPence: sum(open, (i) => i.balancePence),
      overduePence: sum(late, (i) => i.balancePence),
      owedCount: open.length,
      overdueCount: late.length,
    },
    jobs,
    time: {
      totalMinutes: total,
      byPerson: total ? [{ ...c.user, minutes: total }] : [],
      byJob: [...byJob.values()].sort((a, b) => b.minutes - a.minutes),
    },
  };
}
