/**
 * Turning what a reader found into a draft bill, and guessing which job it belongs to.
 * Nothing here saves anything: the result fills the bill review screen for Joe to check.
 */
import type { BillCreate } from '../bills';
import { lineTotal } from '../money';
import type { ReadBill } from './parse';

/** Net cost per unit after discount, half up to the penny, plus the printed total when needed. */
function lineCost(qtyMilli: number, totalPence: number) {
  const unitCostPence = Math.floor((totalPence * 1000 * 2 + qtyMilli) / (qtyMilli * 2));
  return lineTotal(qtyMilli, unitCostPence) === totalPence
    ? { unitCostPence }
    : { unitCostPence, totalPence };
}

export function readBillNotes(b: ReadBill): string | null {
  const parts = [
    b.orderNumber && `Order number: ${b.orderNumber}`,
    b.yourReference && `Your reference: ${b.yourReference}`,
    b.dueDateNote && b.dueDate && `Due ${b.dueDate} (${b.dueDateNote.toLowerCase()})`,
    ...b.lines
      .filter((l) => l.discountBp || l.rrpPence)
      .map(
        (l) =>
          `${l.code ?? l.description}: list ${(l.unitPricePence / 100).toFixed(2)}` +
          (l.discountBp ? ` less ${l.discountBp / 100}%` : '') +
          (l.rrpPence ? `, RRP ${(l.rrpPence / 100).toFixed(2)}` : ''),
      ),
    ...b.problems.map((p) => `Check: ${p}`),
  ].filter(Boolean);
  return parts.length ? parts.join('\n').slice(0, 2000) : null;
}

export function readBillToCreate(
  b: ReadBill,
  opts: { fileName: string | null; jobId?: string | null },
): BillCreate {
  return {
    supplier: b.supplier,
    kind: b.kind,
    reference: b.reference,
    billDate: b.billDate ?? '',
    dueDate: b.dueDate,
    jobId: opts.jobId ?? null,
    source: 'pdf',
    fileName: opts.fileName,
    notes: readBillNotes(b),
    lines: b.lines.map((l) => ({
      code: l.code,
      description: l.description.slice(0, 300) || (l.code ?? 'Item'),
      qtyMilli: l.qtyMilli,
      ...lineCost(l.qtyMilli, l.totalPence),
      updatePrice: true,
    })),
  };
}

export type JobLike = { id: string; number: string; title: string; customerName: string };
export type JobSuggestion = { jobId: string; number: string; title: string; why: string };

/** References that mean "not for a job". */
const NOT_A_JOB = new Set(['STOCK', 'VAN', 'SHOP', 'WORKSHOP', 'CASH']);
const SKIP = new Set([
  'THE',
  'AND',
  'FOR',
  'JOB',
  'NEW',
  'OLD',
  'REPLACEMENT',
  'REPAIR',
  'WORK',
  'WORKS',
  'MR',
  'MRS',
  'MS',
]);
const words = (s: string) =>
  s
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !SKIP.has(w));

/**
 * The job an order number or "your reference" points at: Joe types the job or customer name
 * into the merchant's order box ("OLD BAKERY REWIRE", "REDACTED REF"). Returns the
 * single best match, or nothing when it is stock, unclear, or a tie.
 */
export function suggestJob(refs: (string | null)[], jobs: JobLike[]): JobSuggestion | null {
  const texts = refs.filter((r): r is string => !!r?.trim());
  if (!texts.length || texts.every((t) => NOT_A_JOB.has(t.trim().toUpperCase()))) return null;
  const refWords = new Set(texts.flatMap(words));
  const scored = jobs.map((j) => {
    if (texts.some((t) => t.trim().toUpperCase() === j.number.toUpperCase()))
      return { j, score: 100, why: `The reference is job ${j.number}` };
    const hits = [...new Set([...words(j.title), ...words(j.customerName)])].filter((w) =>
      refWords.has(w),
    );
    return {
      j,
      score: hits.length,
      why: `The reference mentions ${hits.map((h) => h.toLowerCase()).join(', ')}`,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < 1 || (next && next.score === best.score)) return null;
  return { jobId: best.j.id, number: best.j.number, title: best.j.title, why: best.why };
}
