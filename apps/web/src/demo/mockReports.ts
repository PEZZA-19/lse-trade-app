import {
  profitFigures,
  quotedLabourCost,
  labourValue,
  personLabourCost,
  type JobCostingDto,
  type LabourCostRow,
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
  timesheets: { jobId: string; startedAt: string; endedAt: string; userId?: string }[];
  user: { id: string; name: string };
  members: { userId: string; name: string }[];
  /** Base + on-cost per hour, or null when not set. */
  costRate: (userId: string) => number | null;
  labourRatePence: number;
  /** Default markup, to estimate the cost of quoted lines with no cost. */
  markupBp?: number;
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
    .map((j) => jobProfitFor(c, j, details))
    .filter((j) => j.quotedPence !== null || j.minutes > 0 || j.materialsCostPence > 0);

  const sheets = c.timesheets.filter((s) => inRange(localDate(s.startedAt)));
  const byJob = new Map<string, TimeReportDto['byJob'][number]>();
  const people = new Map<string, { id: string; name: string; minutes: number }>();
  for (const s of sheets) {
    const m = minutesOf(s);
    const j = jobs.find((x) => x.jobId === s.jobId);
    const uid = s.userId ?? c.user.id;
    const name = c.members.find((x) => x.userId === uid)?.name ?? c.user.name;
    const row = byJob.get(s.jobId) ?? {
      id: s.jobId,
      name: j?.title ?? 'Job',
      number: j?.number ?? '',
      minutes: 0,
      byPerson: [],
    };
    row.minutes += m;
    const p = row.byPerson.find((x) => x.id === uid);
    if (p) p.minutes += m;
    else row.byPerson.push({ id: uid, name, minutes: m });
    byJob.set(s.jobId, row);
    const q = people.get(uid) ?? { id: uid, name, minutes: 0 };
    q.minutes += m;
    people.set(uid, q);
  }
  const total = sum(sheets, minutesOf);
  return {
    from,
    to,
    labourRatePence: c.labourRatePence,
    costRates: (() => {
      const people = [...new Set(c.timesheets.map((t) => t.userId ?? c.user.id))];
      return { set: people.filter((p) => c.costRate(p) !== null).length, people: people.length };
    })(),
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
      byPerson: [...people.values()].sort((a, b) => b.minutes - a.minutes),
      byJob: [...byJob.values()].sort((a, b) => b.minutes - a.minutes),
    },
  };
}

const sumOf = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

/** Labour rows for one job: minutes per person at their cost rate (labour rate if unset). */
function labourRows(c: ReportsCtx, jobId: string): LabourCostRow[] {
  const by = new Map<string, number>();
  for (const t of c.timesheets.filter((x) => x.jobId === jobId)) {
    const u = t.userId ?? c.user.id;
    by.set(u, (by.get(u) ?? 0) + minutesOf(t));
  }
  return [...by.entries()]
    .map(([userId, minutes]) => {
      const rate = c.costRate(userId);
      return {
        userId,
        name: c.members.find((m) => m.userId === userId)?.name ?? c.user.name,
        minutes,
        ratePence: rate ?? c.labourRatePence,
        rateIsDefault: rate === null,
        costPence: personLabourCost(minutes, rate, c.labourRatePence),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function jobProfitFor(c: ReportsCtx, j: JobDetailDto, details: InvoiceDetailDto[]): JobProfitDto {
  const quoteLines = j.lines.filter((l) => l.source === 'quote');
  const rows = labourRows(c, j.id);
  const minutes = sumOf(rows, (r) => r.minutes);
  const parts = {
    quotedPence: quoteLines.length ? sumOf(quoteLines, (l) => l.totalPence) : null,
    lineValuePence: sumOf(j.lines, (l) => l.totalPence),
    labourPence: sumOf(rows, (r) => r.costPence),
    materialsCostPence: sumOf(
      j.lines.filter((l) => l.kind === 'material' && l.source !== 'quote'),
      (l) => Math.round(((l.unitCostPence ?? 0) * l.qtyMilli) / 1000),
    ),
  };
  const chargeOutPence = labourValue(minutes, c.labourRatePence);
  // Net of approved credit notes (scaled to ex VAT like the server).
  const invoicedPence = sumOf(
    details.filter((d) => d.jobId === j.id),
    (d) =>
      d.subtotalPence -
      (d.totalPence > 0 ? Math.round((d.creditedPence * d.subtotalPence) / d.totalPence) : 0),
  );
  const rates = c.members.map((m) => c.costRate(m.userId)).filter((r): r is number => r !== null);
  const fallbackRatePence = rates.length
    ? Math.round(sumOf(rates, (r) => r) / rates.length)
    : c.labourRatePence;
  const markup = c.markupBp ?? 13000;
  return {
    jobId: j.id,
    number: j.number,
    title: j.title,
    customerName: j.customerName,
    stage: j.stage.name,
    ...parts,
    minutes,
    chargeOutPence,
    missingCostRates: rows.filter((r) => r.rateIsDefault).length,
    invoicedPence,
    ...profitFigures({
      ...parts,
      chargeOutPence,
      invoicedPence,
      quotedLabourCostPence: quotedLabourCost({
        quotedMinutes: Math.round(
          (sumOf(
            quoteLines.filter((l) => l.kind === 'labour'),
            (l) => l.qtyMilli,
          ) *
            60) /
            1000,
        ),
        minutes,
        labourPence: parts.labourPence,
        fallbackRatePence,
      }),
      quotedMaterialsCostPence: sumOf(
        quoteLines.filter((l) => l.kind !== 'labour'),
        (l) =>
          l.unitCostPence !== null
            ? Math.round((l.unitCostPence * l.qtyMilli) / 1000)
            : Math.round((l.totalPence * 10000) / markup),
      ),
    }),
  };
}

/** GET /jobs/:id/costing in the demo (same rules as the server). */
export function demoJobCosting(c: ReportsCtx, jobId: string): JobCostingDto {
  const j = c.call('GET', `/jobs/${jobId}`) as JobDetailDto;
  const invoices = (c.call('GET', `/invoices?filter=all&jobId=${jobId}`) as InvoiceSummaryDto[])
    .filter((i) => i.status !== 'draft' && i.jobId === jobId)
    .map((i) => c.call('GET', `/invoices/${i.id}`) as InvoiceDetailDto);
  const q = j.lines.filter((l) => l.source === 'quote');
  const rows = labourRows(c, jobId);
  return {
    profit: jobProfitFor(c, j, invoices),
    quoted: {
      labourMinutes: Math.round(
        (sumOf(
          q.filter((l) => l.kind === 'labour'),
          (l) => l.qtyMilli,
        ) *
          60) /
          1000,
      ),
      labourPence: sumOf(
        q.filter((l) => l.kind === 'labour'),
        (l) => l.totalPence,
      ),
      materialsPence: sumOf(
        q.filter((l) => l.kind === 'material'),
        (l) => l.totalPence,
      ),
      otherPence: sumOf(
        q.filter((l) => l.kind !== 'labour' && l.kind !== 'material'),
        (l) => l.totalPence,
      ),
    },
    labour: rows,
    extraMaterialsSellPence: sumOf(
      j.lines.filter((l) => l.kind === 'material' && l.source !== 'quote'),
      (l) => l.totalPence,
    ),
    allRatesSet: rows.every((r) => !r.rateIsDefault),
  };
}
