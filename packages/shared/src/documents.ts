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
import type { CreditNoteDto } from './creditNotes';
import type { InvoiceDetailDto, InvoiceLineKind } from './invoices';
import { DEFAULT_INVOICE_TERMS, addDaysIso } from './invoices';
import { formatPence, formatQty, type Pence } from './money';
import type { SettingsDto } from './settings';

export type DocKind = 'invoice' | 'quote' | 'credit_note';

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
    /** PNG/JPEG data URL shown instead of the initials square. */
    logoDataUrl: string | null;
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
> & { logoDataUrl?: string | null };

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
    logoDataUrl: s.logoDataUrl ?? null,
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
  // A job that came to less than £0: a customer credit note, used on their next invoice.
  const credit = inv.status === 'credit' || (draft && inv.totalPence < 0);
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
    label: credit ? 'Credit to you' : 'Total',
    value: formatPence(credit ? -inv.totalPence : inv.totalPence),
    pence: credit ? -inv.totalPence : inv.totalPence,
    strong: true,
  });
  // Credit used after the invoice was issued doesn't change the invoice as billed.
  for (const u of (inv.creditsApplied ?? []).filter((x) => !x.afterIssue))
    totals.push({
      label: `Credit ${u.creditNumber} used`,
      value: formatPence(-u.amountPence),
      pence: -u.amountPence,
    });
  if (credit && (inv.creditUses ?? []).length) {
    for (const u of inv.creditUses)
      totals.push({
        label: `Used on invoice ${u.invoiceNumber}`,
        value: formatPence(-u.amountPence),
        pence: -u.amountPence,
      });
    totals.push({
      label: 'Credit left',
      value: formatPence(-inv.balancePence),
      pence: -inv.balancePence,
      strong: true,
    });
  }
  if (inv.paidPence > 0)
    totals.push({ label: 'Paid', value: formatPence(-inv.paidPence), pence: -inv.paidPence });
  for (const cn of inv.creditNotes ?? [])
    if (cn.status === 'approved')
      totals.push({
        label: `Credit note ${cn.number}`,
        value: formatPence(-cn.amountPence),
        pence: -cn.amountPence,
      });
  // Credit used after issue lowers the job's costs, not what's owed (Joe, 18 Nov 11:34), so it is
  // in neither creditedPence nor the balance, and is left off the document.
  if (!credit && (inv.paidPence > 0 || (inv.creditedPence ?? 0) > 0)) {
    const due = inv.balancePence;
    totals.push({
      label: 'Balance due',
      value: formatPence(due),
      pence: due,
      strong: true,
    });
  }
  const meta: BusinessDocument['meta'] = [];
  if (inv.issueDate)
    meta.push({
      label: credit ? 'Credit note date' : 'Invoice date',
      value: formatDocDate(inv.issueDate),
    });
  if (inv.dueDate) meta.push({ label: 'Due date', value: formatDocDate(inv.dueDate) });
  meta.push({ label: 'Job', value: inv.jobNumber });
  if (inv.quoteNumber) meta.push({ label: 'Quote', value: inv.quoteNumber });
  const billLines = [...splitLines(inv.billTo.address)];
  if (inv.billTo.email) billLines.push(inv.billTo.email);
  return {
    kind: 'invoice',
    title: credit ? 'Credit Note' : 'Invoice',
    number,
    draftLabel: draft ? 'Draft: not approved' : null,
    business: businessBlock(s),
    billTo: { name: inv.billTo.name, lines: billLines },
    meta,
    jobTitle: inv.jobTitle,
    siteLines: splitLines(extra.siteAddress),
    sections,
    totals,
    payment: credit ? null : paymentBlock(s, `INV ${number}`),
    notes: inv.notes,
    terms: credit
      ? 'This credit will be taken off your next invoice from us. It is not paid out.'
      : (s.invoiceTerms ?? inv.termsText ?? DEFAULT_INVOICE_TERMS(inv.termsDays)),
    fileName: draft
      ? `${credit ? 'Credit note' : 'Invoice'} draft (job ${inv.jobNumber}).pdf`
      : `${credit ? 'Credit note' : 'Invoice'} ${number}.pdf`,
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

/**
 * Credit note layout: the same header, who it's for and the job, one line saying what is credited
 * and why, then the effect on the invoice. No bank details: the customer has nothing to pay.
 */
export function creditNoteDocument(
  cn: CreditNoteDto,
  s: Business,
  extra: { siteAddress?: string | null } = {},
): BusinessDocument {
  const draft = cn.status === 'draft';
  const number = cn.number ?? 'Draft';
  const amount = formatPence(cn.amountPence);
  const rows: DocRow[] = [
    {
      description: cn.reason,
      detail: `Against invoice ${cn.invoiceNumber}`,
      qty: '1',
      rate: amount,
      amount,
      amountPence: cn.amountPence,
    },
  ];
  const balanceAfter = draft ? cn.invoiceBalancePence - cn.amountPence : cn.invoiceBalancePence;
  const meta: BusinessDocument['meta'] = [];
  if (cn.issueDate) meta.push({ label: 'Date', value: formatDocDate(cn.issueDate) });
  meta.push({ label: 'Invoice', value: cn.invoiceNumber });
  meta.push({ label: 'Job', value: cn.jobNumber });
  const billLines = [...splitLines(cn.billTo.address)];
  if (cn.billTo.email) billLines.push(cn.billTo.email);
  return {
    kind: 'credit_note',
    title: 'Credit Note',
    number,
    draftLabel: draft ? 'Draft: not approved' : null,
    business: businessBlock(s),
    billTo: { name: cn.billTo.name, lines: billLines },
    meta,
    jobTitle: cn.jobTitle,
    siteLines: splitLines(extra.siteAddress),
    sections: [section('Credit', rows)],
    totals: [
      { label: 'Total credit', value: amount, pence: cn.amountPence, strong: true },
      {
        label: `Invoice ${cn.invoiceNumber} total`,
        value: formatPence(cn.invoiceTotalPence),
        pence: cn.invoiceTotalPence,
      },
      {
        label: 'Balance now due',
        value: formatPence(Math.max(0, balanceAfter)),
        pence: Math.max(0, balanceAfter),
        strong: true,
      },
    ],
    payment: null,
    notes:
      balanceAfter <= 0
        ? `This credit settles invoice ${cn.invoiceNumber}. There is nothing more to pay.`
        : `This credit has been taken off invoice ${cn.invoiceNumber}.`,
    terms: null,
    fileName: draft
      ? `Credit note draft (invoice ${cn.invoiceNumber}).pdf`
      : `Credit note ${number}.pdf`,
  };
}
