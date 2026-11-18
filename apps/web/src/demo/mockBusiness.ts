import type { z } from 'zod';
import {
  billPaymentCreate,
  budgetMonths,
  budgetUpdate,
  expenseCreate,
  openingBalanceUpdate,
  type ExpenseDto,
  type BillDetailDto,
  type BillPaymentDto,
  type BillSummaryDto,
  type BusinessDto,
  type InvoiceDetailDto,
  type InvoiceSummaryDto,
  type LedgerBudget,
  type QuoteSummaryDto,
} from '@lse/shared';

/** Demo-only books: the bits the real server keeps in business_books, budgets and bill payments. */
export interface BusinessDb {
  opening: { date: string; bankPence: number } | null;
  budgets: LedgerBudget[];
  billPayments: (BillPaymentDto & { billId: string })[];
  /** Expenses and wages (older saved demos don't have it yet). */
  expenses?: ExpenseDto[];
}
export const freshBusiness = (): BusinessDb => ({
  opening: null,
  budgets: [],
  billPayments: [],
  expenses: [],
});

export interface BusinessCtx {
  db: BusinessDb;
  call: (method: string, path: string) => unknown;
  jobs: { stageId: string; lines: { totalPence: number }[] }[];
  stages: {
    id: string;
    name: string;
    colour: string;
    systemKey: string | null;
    sortOrder: number;
  }[];
  today: string;
  yearStart: string;
  yearEffectiveFrom: string;
  parse: <S extends z.ZodType>(schema: S, data: unknown) => z.output<S>;
  fail: (status: number, code: string, message: string) => never;
  uid: () => string;
  now: () => string;
}

/** The demo's GET /business, built from the same mock endpoints the screens use (mirrors the server). */
export function demoBusiness(c: BusinessCtx): BusinessDto {
  const invoices = (c.call('GET', '/invoices?filter=all') as InvoiceSummaryDto[]).filter(
    (i) => i.status !== 'draft' && !!i.issueDate,
  );
  const details = invoices.map((i) => c.call('GET', `/invoices/${i.id}`) as InvoiceDetailDto);
  const bills = (c.call('GET', '/supplier-bills?status=applied') as BillSummaryDto[]).map(
    (b) => c.call('GET', `/supplier-bills/${b.id}`) as BillDetailDto,
  );
  const sent = (
    c.call('GET', '/quotes?status=sent&limit=100') as { items: QuoteSummaryDto[] }
  ).items.filter((q) => q.status === 'sent');
  return {
    today: c.today,
    yearStart: c.yearStart,
    yearEffectiveFrom: c.yearEffectiveFrom,
    opening: c.db.opening,
    invoices: details.map((d) => ({
      id: d.id,
      number: d.number,
      customerId: d.customerName,
      customerName: d.customerName,
      jobNumber: d.jobNumber,
      issueDate: d.issueDate!,
      dueDate: d.dueDate,
      labourNetPence: d.lines
        .filter((l) => l.kind === 'labour')
        .reduce((s, l) => s + l.totalPence, 0),
      netPence: d.subtotalPence,
      taxPence: d.taxPence,
      totalPence: d.totalPence,
    })),
    payments: details.flatMap((d) =>
      d.payments.map((p) => ({
        id: p.id,
        invoiceId: d.id,
        date: p.paidOn,
        amountPence: p.amountPence,
        method: p.method,
        reference: p.reference ?? null,
      })),
    ),
    credits: details.flatMap((d) =>
      d.creditNotes
        .filter((n) => n.status === 'approved' && !!n.issueDate)
        .map((n) => ({
          id: n.id,
          invoiceId: d.id,
          number: n.number,
          date: n.issueDate!,
          amountPence: n.amountPence,
        })),
    ),
    // Each use appears on both the credit and the invoice it went on; count it once.
    creditUses: details.flatMap((d) =>
      d.creditsApplied.map((u) => ({
        id: u.id,
        creditId: u.creditId,
        invoiceId: u.invoiceId,
        date: u.appliedOn,
        amountPence: u.amountPence,
      })),
    ),
    bills: bills.map((b) => ({
      id: b.id,
      supplierId: b.supplierId,
      supplierName: b.supplierName,
      reference: b.reference,
      kind: b.kind,
      date: b.billDate,
      dueDate: b.dueDate,
      totalPence: b.totalPence,
      homePence: b.lines
        .filter((l) => l.allocation === 'home')
        .reduce((s, l) => s + l.totalPence, 0),
    })),
    billPayments: c.db.billPayments.map((p) => ({
      id: p.id,
      billId: p.billId,
      date: p.paidOn,
      amountPence: p.amountPence,
      method: p.method,
      reference: p.reference,
    })),
    expenses: (c.db.expenses ?? []).map(({ memberUserId: _m, createdAt: _c, ...e }) => e),
    budgets: c.db.budgets,
    pipeline: [...c.stages]
      .filter((s) => s.systemKey !== 'cancelled')
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((s) => {
        const js = c.jobs.filter((j) => j.stageId === s.id);
        return {
          key: s.id,
          name: s.name,
          colour: s.colour,
          count: js.length,
          valuePence: js.reduce((t, j) => t + j.lines.reduce((u, l) => u + l.totalPence, 0), 0),
        };
      }),
    openQuotes: { count: sent.length, valuePence: sent.reduce((s, q) => s + q.totalPence, 0) },
  };
}

/** /business and /supplier-bills/:id/payments in the demo; undefined when the path isn't ours. */
export function businessRoute(
  c: BusinessCtx,
  method: string,
  seg: string[],
  body: unknown,
): unknown {
  const [a, id, sub] = seg;
  if (a === 'business') {
    if (method === 'GET' && !id) return demoBusiness(c);
    if (method === 'PUT' && id === 'opening') {
      c.db.opening = c.parse(openingBalanceUpdate, body);
      return demoBusiness(c);
    }
    if (method === 'PUT' && id === 'budget') {
      const input = c.parse(budgetUpdate, body);
      const months = budgetMonths(input.year, input.startMonth);
      for (const line of input.lines) {
        c.db.budgets = c.db.budgets.filter(
          (b) => !(b.account === line.account && months.includes(b.month)),
        );
        line.months.forEach((amount, i) => {
          if (amount > 0)
            c.db.budgets.push({ month: months[i]!, account: line.account, amountPence: amount });
        });
      }
      return demoBusiness(c);
    }
    return undefined;
  }
  if (a === 'expenses') {
    const list = (c.db.expenses ??= []);
    if (method === 'GET' && !id)
      return [...list].sort(
        (x, y) => y.date.localeCompare(x.date) || y.createdAt.localeCompare(x.createdAt),
      );
    if (method === 'POST' && !id) {
      const input = c.parse(expenseCreate, body);
      if (input.date > c.today) c.fail(422, 'future_date', 'The date can’t be in the future.');
      const e: ExpenseDto = {
        id: c.uid(),
        date: input.date,
        payee: input.payee,
        account: input.account,
        description: input.description,
        amountPence: input.amountPence,
        taxPence: input.taxPence,
        paidFrom: input.paidFrom,
        memberUserId: input.memberUserId ?? null,
        createdAt: c.now(),
      };
      list.push(e);
      return e;
    }
    if (method === 'DELETE' && id) {
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) c.fail(404, 'not_found', 'Expense not found');
      list.splice(i, 1);
      return null;
    }
    return undefined;
  }
  if (a === 'supplier-bills' && id && sub === 'payments') {
    const bill = c.call('GET', `/supplier-bills/${id}`) as BillDetailDto;
    const list = () =>
      c.db.billPayments.filter((p) => p.billId === id).map(({ billId: _b, ...p }) => p);
    if (method === 'GET') return list();
    if (method === 'POST') {
      const input = c.parse(billPaymentCreate, body);
      if (bill.kind !== 'bill' || bill.status !== 'applied')
        c.fail(409, 'bill_not_payable', 'Only an applied supplier bill can be paid.');
      const left = bill.totalPence - list().reduce((s, p) => s + p.amountPence, 0);
      if (input.amountPence > left)
        c.fail(
          422,
          'overpayment',
          left <= 0
            ? 'This bill is already paid in full.'
            : `Only £${(left / 100).toFixed(2)} is still owed on this bill.`,
        );
      if (input.paidOn > c.today)
        c.fail(422, 'future_date', 'The payment date can’t be in the future.');
      c.db.billPayments.push({
        id: c.uid(),
        billId: id,
        amountPence: input.amountPence,
        paidOn: input.paidOn,
        method: input.method,
        reference: input.reference || null,
        createdAt: c.now(),
      });
      return list();
    }
  }
  return undefined;
}
