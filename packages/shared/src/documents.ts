/**
 * Customer documents (quotes and invoices) as one layout model, rendered twice from the same data:
 * HTML for the in-app preview and a PDF (see ./pdf) for sharing. Follows the LSE layout: header with
 * logo, business name, address, email and phone; who it's for; labour itemised, then materials;
 * carriage only when it isn't zero; totals; bank details with the reference; terms. No VAT wording
 * unless a tax rate is actually set, and no vendor footer.
 *
 * Nothing LSE-specific lives here: every name, address and bank detail comes from tenant settings.
 */
import type { QuoteDetailDto } from './dto';
import type { InvoiceDetailDto, InvoiceLineKind } from './invoices';
import { DEFAULT_INVOICE_TERMS, addDaysIso } from './invoices';
import { formatPence, formatQty, type Pence } from './money';
import type { SettingsDto } from './settings';

export type DocKind = 'invoice' | 'quote';

export interface DocRow {
  description: string;
  /** Detail under the description, e.g. a kit's components. */
  detail: string | null;
  qty: string;
  rate: string;
  amount: string;
  amountPence: Pence;
}

export interface DocSection {
  title: string;
  /** Column heading for the quantity: "Hours" for labour, else "Qty". */
  qtyLabel: string;
  rows: DocRow[];
  totalPence: Pence;
  total: string;
  /** Optional extras are listed but not included in the total. */
  optional: boolean;
}

export interface DocTotal {
  label: string;
  value: string;
  pence: Pence;
  strong?: boolean;
}

export interface BusinessDocument {
  kind: DocKind;
  /** "Invoice" / "Quote". */
  title: string;
  /** "122-2", "Q-0012 rev B", or "Draft" for an invoice that has no number yet. */
  number: string;
  /** Shown as a watermark and in the header until the document is approved/sent. */
  draftLabel: string | null;
  business: {
    name: string;
    legalName: string | null;
    initials: string;
    addressLines: string[];
    email: string | null;
    phone: string | null;
  };
  billTo: { name: string; lines: string[] };
  /** Dates and references, in order. */
  meta: { label: string; value: string }[];
  jobTitle: string;
  siteLines: string[];
  sections: DocSection[];
  totals: DocTotal[];
  payment: {
    accountName: string;
    sortCode: string;
    accountNumber: string;
    reference: string;
  } | null;
  notes: string | null;
  terms: string | null;
  /** File name for sharing, e.g. "Invoice 122-2.pdf". */
  fileName: string;
}

type Business = Pick<
  SettingsDto,
  | 'name'
  | 'legalName'
  | 'address'
  | 'email'
  | 'phone'
  | 'bankAccountName'
  | 'bankSortCode'
  | 'bankAccountNumber'
  | 'quoteTerms'
  | 'invoiceTerms'
>;

export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n|,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "Little Sark Electric" -> "LSE"; one word -> its first two letters. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, '')
    .split(/[\s&-]+/)
    .filter((w) => /^[A-Za-z]/.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** 2026-11-11 -> "11 Nov 2026" (dates are calendar dates: no time zone shift). */
export function formatDocDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  return `${d} ${months[(m ?? 1) - 1]} ${y}`;
}

function businessBlock(s: Business): BusinessDocument['business'] {
  return {
    name: s.name,
    legalName: s.legalName && s.legalName !== s.name ? s.legalName : null,
    initials: initialsOf(s.name),
    addressLines: splitLines(s.address),
    email: s.email,
    phone: s.phone,
  };
}

function paymentBlock(s: Business, reference: string): BusinessDocument['payment'] {
  if (!s.bankAccountName || !s.bankSortCode || !s.bankAccountNumber) return null;
  return {
    accountName: s.bankAccountName,
    sortCode: s.bankSortCode,
    accountNumber: s.bankAccountNumber,
    reference,
  };
}

function row(
  description: string,
  qtyMilli: number,
  unitPence: Pence,
  totalPence: Pence,
  opts: { hours?: boolean; detail?: string | null } = {},
): DocRow {
  return {
    description,
    detail: opts.detail ?? null,
    qty: opts.hours ? `${formatQty(qtyMilli)} h` : formatQty(qtyMilli),
    rate: formatPence(unitPence),
    amount: formatPence(totalPence),
    amountPence: totalPence,
  };
}

function section(title: string, rows: DocRow[], qtyLabel = 'Qty', optional = false): DocSection {
  const totalPence = rows.reduce((s, r) => s + r.amountPence, 0);
  return { title, qtyLabel, rows, totalPence, total: formatPence(totalPence), optional };
}

const INVOICE_GROUPS: { kinds: InvoiceLineKind[]; title: string; qtyLabel: string }[] = [
  { kinds: ['labour'], title: 'Labour', qtyLabel: 'Hours' },
  { kinds: ['material'], title: 'Materials', qtyLabel: 'Qty' },
  { kinds: ['pc_sum'], title: 'Allowances', qtyLabel: 'Qty' },
  { kinds: ['deposit', 'adjustment'], title: 'Other', qtyLabel: 'Qty' },
];

/** Invoice layout. Drafts show "Draft" in place of the number (numbers are given on approval). */
export function invoiceDocument(
  inv: InvoiceDetailDto,
  s: Business,
  extra: { siteAddress?: string | null } = {},
): BusinessDocument {
  const draft = inv.status === 'draft';
  const number = inv.number ?? 'Draft';
  const sections: DocSection[] = [];
  for (const g of INVOICE_GROUPS) {
    const rows = inv.lines
      .filter((l) => g.kinds.includes(l.kind))
      .map((l) =>
        row(l.description, l.qtyMilli, l.unitPricePence, l.totalPence, {
          hours: l.kind === 'labour',
        }),
      );
    if (rows.length) sections.push(section(g.title, rows, g.qtyLabel));
  }
  const carriagePence = inv.lines
    .filter((l) => l.kind === 'carriage')
    .reduce((t, l) => t + l.totalPence, 0);
  const totals: DocTotal[] = [];
  const subtotal = inv.subtotalPence - carriagePence;
  totals.push({ label: 'Subtotal', value: formatPence(subtotal), pence: subtotal });
  // Spec: the carriage line is hidden when it is zero.
  if (carriagePence !== 0)
    totals.push({ label: 'Carriage', value: formatPence(carriagePence), pence: carriagePence });
  // No VAT wording unless tax is actually charged (Guernsey and Sark have no VAT).
  if (inv.taxPence !== 0)
    totals.push({ label: 'Tax', value: formatPence(inv.taxPence), pence: inv.taxPence });
  totals.push({
    label: 'Total',
    value: formatPence(inv.totalPence),
    pence: inv.totalPence,
    strong: true,
  });
  if (inv.paidPence > 0) {
    totals.push({ label: 'Paid', value: formatPence(-inv.paidPence), pence: -inv.paidPence });
    totals.push({
      label: 'Balance due',
      value: formatPence(inv.balancePence),
      pence: inv.balancePence,
      strong: true,
    });
  }
  const meta: BusinessDocument['meta'] = [];
  if (inv.issueDate) meta.push({ label: 'Invoice date', value: formatDocDate(inv.issueDate) });
  if (inv.dueDate) meta.push({ label: 'Due date', value: formatDocDate(inv.dueDate) });
  meta.push({ label: 'Job', value: inv.jobNumber });
  if (inv.quoteNumber) meta.push({ label: 'Quote', value: inv.quoteNumber });
  const billLines = [...splitLines(inv.billTo.address)];
  if (inv.billTo.email) billLines.push(inv.billTo.email);
  return {
    kind: 'invoice',
    title: 'Invoice',
    number,
    draftLabel: draft ? 'Draft: not approved' : null,
    business: businessBlock(s),
    billTo: { name: inv.billTo.name, lines: billLines },
    meta,
    jobTitle: inv.jobTitle,
    siteLines: splitLines(extra.siteAddress),
    sections,
    totals,
    payment: paymentBlock(s, `INV ${number}`),
    notes: inv.notes,
    terms: s.invoiceTerms ?? inv.termsText ?? DEFAULT_INVOICE_TERMS(inv.termsDays),
    fileName: draft ? `Invoice draft (job ${inv.jobNumber}).pdf` : `Invoice ${number}.pdf`,
  };
}

/** Quote layout: core scope by kind, optional extras listed separately and not in the total. */
export function quoteDocument(
  q: QuoteDetailDto,
  s: Business,
  billTo: { name: string; address: string | null; email: string | null },
  todayIso: string,
): BusinessDocument {
  const rev = q.current;
  const core = rev.lines.filter((l) => l.optionLabel == null);
  const sections: DocSection[] = [];
  const kindRows = (kind: string) =>
    core
      .filter((l) => l.kind === kind)
      .map((l) =>
        row(
          l.kind === 'pc_sum' ? `Allowance: ${l.description}` : l.description,
          l.qtyMilli,
          l.unitSellPence,
          l.totalPence,
          {
            hours: l.kind === 'labour',
            detail: l.kit
              ? l.kit.components
                  .map((c) =>
                    c.unit === 'each'
                      ? `${formatQty(c.qtyMilli)} ${c.description}`
                      : `${formatQty(c.qtyMilli)} ${c.unit} ${c.description}`,
                  )
                  .join(' · ')
              : null,
          },
        ),
      );
  const labour = kindRows('labour');
  if (labour.length) sections.push(section('Labour', labour, 'Hours'));
  const materials = kindRows('material');
  if (materials.length) sections.push(section('Materials', materials));
  const pcs = kindRows('pc_sum');
  if (pcs.length) sections.push(section('Allowances', pcs));
  const carriagePence = core
    .filter((l) => l.kind === 'carriage')
    .reduce((t, l) => t + l.totalPence, 0);
  const options = [...new Set(rev.lines.map((l) => l.optionLabel).filter(Boolean))] as string[];
  for (const label of options) {
    const rows = rev.lines
      .filter((l) => l.optionLabel === label)
      .map((l) =>
        row(l.description, l.qtyMilli, l.unitSellPence, l.totalPence, {
          hours: l.kind === 'labour',
        }),
      );
    sections.push(section(`Optional extra: ${label}`, rows, 'Qty', true));
  }
  const subtotal = rev.totals.corePence - carriagePence;
  const totals: DocTotal[] = [{ label: 'Subtotal', value: formatPence(subtotal), pence: subtotal }];
  if (carriagePence !== 0)
    totals.push({ label: 'Carriage', value: formatPence(carriagePence), pence: carriagePence });
  totals.push({
    label: options.length ? 'Total (without extras)' : 'Total',
    value: formatPence(rev.totals.corePence),
    pence: rev.totals.corePence,
    strong: true,
  });
  const date = (rev.sentAt ?? todayIso).slice(0, 10);
  const number = rev.revision > 1 ? `${q.number} rev ${rev.revisionLetter}` : q.number;
  const billLines = [...splitLines(billTo.address)];
  if (billTo.email) billLines.push(billTo.email);
  const defaultTerms = `This quote is valid for ${rev.validDays} days from the date above.`;
  return {
    kind: 'quote',
    title: 'Quote',
    number,
    draftLabel: rev.supersededAt ? 'Superseded' : null,
    business: businessBlock(s),
    billTo: { name: billTo.name, lines: billLines },
    meta: [
      { label: 'Date', value: formatDocDate(date) },
      { label: 'Valid until', value: formatDocDate(addDaysIso(date, rev.validDays)) },
    ],
    jobTitle: rev.title,
    siteLines: splitLines(q.site?.address),
    sections,
    totals,
    payment: null,
    notes: rev.notes,
    terms: s.quoteTerms ? `${defaultTerms}\n${s.quoteTerms}` : defaultTerms,
    fileName: `Quote ${number}.pdf`,
  };
}
