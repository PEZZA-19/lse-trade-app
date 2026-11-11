import type { settingsUpdate } from '@lse/shared';
import {
  logoBytes,
  readiness,
  type ReadinessDto,
  type SequenceDto,
  type SettingsDto,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { AppError, invalid } from '../lib/errors';
import type { Auth } from '../lib/types';
import { audit } from './audit';

const SEQ_TABLE: Partial<Record<SequenceDto['kind'], 'quotes' | 'jobs' | 'credit_notes'>> = {
  quote: 'quotes',
  job: 'jobs',
  credit_note: 'credit_notes',
};

async function lastUsed(tx: Tx, kind: SequenceDto['kind']): Promise<number | null> {
  const table = SEQ_TABLE[kind];
  if (!table) return null; // invoice numbers follow the job number, not a sequence
  const [row] = await tx<{ max: number | null }[]>`SELECT max(seq_value) AS max FROM ${tx(table)}`;
  return row?.max ?? null;
}

export async function getSettings(tx: Tx): Promise<SettingsDto> {
  const [t] = await tx<Omit<SettingsDto, 'sequences'>[]>`
    SELECT name, legal_name, address, phone, email, labour_rate_pence, default_markup_bp, quote_valid_days,
           payment_terms_days, tax_rate_bp, quote_terms, invoice_terms, bank_account_name, bank_sort_code,
           bank_account_number, currency, timezone, logo_data_url
      FROM tenants WHERE id = app_current_tenant()`;
  if (!t) throw new AppError(403, 'forbidden', 'No business selected');
  const seqs = await tx<Omit<SequenceDto, 'lastUsed'>[]>`
    SELECT kind, prefix, padding, next_value, gaps_allowed FROM number_sequences
     ORDER BY array_position(ARRAY['quote','job','invoice','credit_note'], kind)`;
  const sequences: SequenceDto[] = [];
  for (const s of seqs) sequences.push({ ...s, lastUsed: await lastUsed(tx, s.kind) });
  return { ...t, sequences };
}

export async function getReadiness(tx: Tx): Promise<ReadinessDto> {
  return readiness(await getSettings(tx));
}

/** Throws 422 with a plain-English list if the business details aren't complete enough to send a quote. */
export async function assertReadyToSendQuote(tx: Tx) {
  const r = await getReadiness(tx);
  if (!r.quote.ready) {
    throw new AppError(
      422,
      'business_details_missing',
      `Add your ${r.quote.missing.map((m) => m.label.toLowerCase()).join(', ')} in Settings before sending.`,
      { missing: r.quote.missing },
    );
  }
}

const COLUMNS = {
  name: 'name',
  legalName: 'legal_name',
  address: 'address',
  phone: 'phone',
  email: 'email',
  labourRatePence: 'labour_rate_pence',
  defaultMarkupBp: 'default_markup_bp',
  quoteValidDays: 'quote_valid_days',
  paymentTermsDays: 'payment_terms_days',
  taxRateBp: 'tax_rate_bp',
  quoteTerms: 'quote_terms',
  invoiceTerms: 'invoice_terms',
  bankAccountName: 'bank_account_name',
  bankSortCode: 'bank_sort_code',
  bankAccountNumber: 'bank_account_number',
} as const;

type ParsedUpdate = z.output<typeof settingsUpdate>;

export async function updateSettings(
  tx: Tx,
  auth: Auth,
  input: ParsedUpdate,
): Promise<SettingsDto> {
  if (auth.role !== 'owner')
    throw new AppError(403, 'forbidden', 'Only the business owner can change settings');
  const before = await getSettings(tx);

  const set: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(COLUMNS)) {
    const v = (input as Record<string, unknown>)[key];
    if (v !== undefined) set[col] = v;
  }
  if (Object.keys(set).length) {
    await tx`UPDATE tenants SET ${tx(set)}, updated_at = now() WHERE id = app_current_tenant()`;
  }

  for (const seq of input.sequences ?? []) {
    // Lock the sequence row so a document can't take a number while we change it.
    const [cur] = await tx<{ nextValue: number }[]>`
      SELECT next_value FROM number_sequences WHERE kind = ${seq.kind} FOR UPDATE`;
    if (!cur) throw invalid(`No ${seq.kind} numbering for this business`);
    const used = await lastUsed(tx, seq.kind);
    if (used !== null && seq.nextValue <= used) {
      throw invalid(
        `The next ${seq.kind.replace('_', ' ')} number must be above ${used}, which is already used.`,
        {
          kind: seq.kind,
          lastUsed: used,
        },
      );
    }
    await tx`
      UPDATE number_sequences
         SET prefix = ${seq.prefix}, padding = ${seq.padding}, next_value = ${seq.nextValue}, updated_at = now()
       WHERE kind = ${seq.kind}`;
  }

  const after = await getSettings(tx);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after) as (keyof SettingsDto)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      changed[k] = { from: before[k], to: after[k] };
  }
  await audit(tx, auth, 'settings.update', 'tenant', auth.tenantId, { changed });
  return after;
}

/** Owner uploads the business logo (already resized on the device). Bytes are checked, not just the label. */
export async function setLogo(tx: Tx, auth: Auth, dataUrl: string | null): Promise<SettingsDto> {
  if (dataUrl !== null && !logoBytes(dataUrl))
    throw invalid('That file isn’t a PNG or JPEG image under 280 KB.', {
      fields: { dataUrl: 'Use a PNG or JPEG under 280 KB' },
    });
  await tx`UPDATE tenants SET logo_data_url = ${dataUrl}, updated_at = now() WHERE id = app_current_tenant()`;
  await audit(
    tx,
    auth,
    dataUrl ? 'settings.logo_set' : 'settings.logo_removed',
    'tenant',
    auth.tenantId,
    {
      bytes: dataUrl ? logoBytes(dataUrl)!.bytes.length : 0,
    },
  );
  return getSettings(tx);
}
