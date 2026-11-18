/**
 * Expenses and wages: overheads that aren't supplier bills for materials, and wages, so the
 * Profit and Loss shows a real net profit. Anyone with Accounts access can see, add and remove
 * them (Joe, 18 Nov 2026: "Anyone with the correct level of access can make the expenses change");
 * the API's access check for /api/expenses enforces it. Every change is audited.
 */
import type { expenseCreate } from '@lse/shared';
import { type ExpenseDto } from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { AppError, notFound } from '../lib/errors';
import { iso, type Auth } from '../lib/types';
import { audit } from './audit';
import { today } from './invoices';

type Input = z.output<typeof expenseCreate>;

interface Row {
  id: string;
  date: string;
  payee: string;
  account: ExpenseDto['account'];
  description: string;
  amountPence: string;
  taxPence: string;
  memberUserId: string | null;
  createdAt: Date;
}
const toDto = (r: Row): ExpenseDto => ({
  ...r,
  amountPence: Number(r.amountPence),
  taxPence: Number(r.taxPence),
  createdAt: iso(r.createdAt)!,
});

export async function listExpenses(tx: Tx, from?: string, to?: string): Promise<ExpenseDto[]> {
  const rows = await tx<Row[]>`
    SELECT id, spent_on::text AS date, payee, account_code AS account, description, amount_pence,
           tax_pence, member_user_id, created_at
      FROM expenses
     WHERE (${from ?? null}::date IS NULL OR spent_on >= ${from ?? null}::date)
       AND (${to ?? null}::date IS NULL OR spent_on <= ${to ?? null}::date)
     ORDER BY spent_on DESC, created_at DESC
     LIMIT 1000`;
  return rows.map(toDto);
}

export async function createExpense(tx: Tx, auth: Auth, input: Input): Promise<ExpenseDto> {
  const t = await today(tx);
  if (input.date > t)
    throw new AppError(422, 'future_date', 'The date can’t be in the future.', {
      fields: { date: 'The date can’t be in the future.' },
    });
  if (input.memberUserId) {
    const [m] =
      await tx`SELECT 1 FROM memberships WHERE tenant_id = ${auth.tenantId} AND user_id = ${input.memberUserId}`;
    if (!m)
      throw new AppError(422, 'validation_failed', 'That person is not part of this business', {
        fields: { memberUserId: 'Not a member' },
      });
  }
  const [row] = await tx<Row[]>`
    INSERT INTO expenses (tenant_id, spent_on, payee, account_code, description, amount_pence, tax_pence, member_user_id, created_by)
    VALUES (${auth.tenantId}, ${input.date}, ${input.payee}, ${input.account}, ${input.description},
            ${input.amountPence}, ${input.taxPence}, ${input.memberUserId ?? null}, ${auth.userId})
    RETURNING id, spent_on::text AS date, payee, account_code AS account, description, amount_pence,
              tax_pence, member_user_id, created_at`;
  await audit(tx, auth, 'create', 'expense', row!.id, {
    account: input.account,
    amountPence: input.amountPence,
  });
  return toDto(row!);
}

export async function deleteExpense(tx: Tx, auth: Auth, id: string): Promise<void> {
  const [row] = await tx<Row[]>`
    DELETE FROM expenses WHERE id = ${id}
    RETURNING id, spent_on::text AS date, payee, account_code AS account, description, amount_pence,
              tax_pence, member_user_id, created_at`;
  if (!row) throw notFound('Expense');
  // The audit keeps what was removed.
  await audit(tx, auth, 'delete', 'expense', id, { ...toDto(row) });
}
