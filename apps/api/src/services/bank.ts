/**
 * Bank statement import (and, next, matching). Importing a CSV only records what the bank says;
 * it never changes the books. Owner only, like recording payments; Accounts access can look.
 */
import {
  parseBankCsv,
  type BankImportResultDto,
  type BankTransactionDto,
  type BankTxStatus,
} from '@lse/shared';
import type { Tx } from '../db/client';
import { AppError } from '../lib/errors';
import { iso, type Auth } from '../lib/types';
import { audit } from './audit';
import { today } from './invoices';

export const ownerOnly = (auth: Auth, what: string) => {
  if (auth.role !== 'owner')
    throw new AppError(403, 'owner_only', `Only the business owner can ${what}.`);
};

export async function importStatement(
  tx: Tx,
  auth: Auth,
  input: { fileName: string; csv: string },
): Promise<BankImportResultDto> {
  ownerOnly(auth, 'import a bank statement');
  const parsed = parseBankCsv(input.csv);
  if (!parsed.rows.length)
    throw new AppError(
      422,
      'bank_csv_unreadable',
      parsed.problems[0]?.line === 0
        ? parsed.problems[0].message
        : 'No transactions could be read from this file.',
      { problems: parsed.problems.slice(0, 20) },
    );
  const t = await today(tx);
  const future = parsed.rows.find((r) => r.date > t);
  if (future)
    throw new AppError(
      422,
      'bank_csv_future',
      `Line ${future.line} is dated ${future.date}, which is in the future. Is this the right file?`,
    );
  const dates = parsed.rows.map((r) => r.date).sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  const [imp] = await tx<{ id: string }[]>`
    INSERT INTO bank_imports (tenant_id, file_name, rows_added, rows_existing, from_date, to_date, created_by)
    VALUES (${auth.tenantId}, ${input.fileName}, 0, 0, ${from}, ${to}, ${auth.userId})
    RETURNING id`;
  const id = imp!.id;
  let added = 0;
  // Batches keep each statement well under Postgres's parameter limit.
  for (let i = 0; i < parsed.rows.length; i += 500) {
    const batch = parsed.rows.slice(i, i + 500).map((r) => ({
      tenant_id: auth.tenantId,
      import_id: id,
      posted_on: r.date,
      description: r.description,
      reference: r.reference,
      amount_pence: r.amountPence,
      balance_pence: r.balancePence,
      fingerprint: r.fingerprint,
    }));
    const ins = await tx`
      INSERT INTO bank_transactions ${tx(batch)}
      ON CONFLICT (tenant_id, fingerprint) DO NOTHING
      RETURNING id`;
    added += ins.length;
  }
  const existing = parsed.rows.length - added;
  await tx`UPDATE bank_imports SET rows_added = ${added}, rows_existing = ${existing} WHERE id = ${id}`;
  await audit(tx, auth, 'create', 'bank_import', id, {
    fileName: input.fileName,
    added,
    alreadyImported: existing,
    from,
    to,
  });
  return {
    importId: id,
    added,
    alreadyImported: existing,
    problems: parsed.problems.slice(0, 50),
    columns: parsed.columns,
    from,
    to,
  };
}

interface TxRow {
  id: string;
  date: string;
  description: string;
  reference: string;
  amountPence: string;
  balancePence: string | null;
  status: BankTxStatus;
  createdAt: Date;
}

export async function listTransactions(
  tx: Tx,
  status: BankTxStatus | 'all',
): Promise<BankTransactionDto[]> {
  const rows = await tx<TxRow[]>`
    SELECT id, posted_on::text AS date, description, reference, amount_pence, balance_pence, status, created_at
      FROM bank_transactions
     WHERE (${status} = 'all' OR status = ${status})
     ORDER BY posted_on DESC, created_at DESC, fingerprint
     LIMIT 2000`;
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    description: r.description,
    reference: r.reference,
    amountPence: Number(r.amountPence),
    balancePence: r.balancePence === null ? null : Number(r.balancePence),
    status: r.status,
    importedAt: iso(r.createdAt)!,
  }));
}
