import type { ContactDto, CustomerDetailDto, CustomerDto, Page, SiteDto } from '@lse/shared';
import type {
  contactInput,
  customerCreate,
  customerUpdate,
  listQuery,
  siteInput,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { invalid, notFound } from '../lib/errors';
import { isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { listJobs } from './jobs';
import { listQuotes } from './quotes';

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  notes: string | null;
  markupBp: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const toCustomer = (r: CustomerRow): CustomerDto => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  billingAddress: r.billingAddress,
  notes: r.notes,
  markupBp: r.markupBp,
  createdAt: isoNN(r.createdAt),
  updatedAt: isoNN(r.updatedAt),
});

export const toSite = (r: {
  id: string;
  customerId: string;
  label: string | null;
  address: string;
  notes: string | null;
}): SiteDto => ({
  id: r.id,
  customerId: r.customerId,
  label: r.label,
  address: r.address,
  notes: r.notes,
});

const CONTACT_COLS = 'id, customer_id, site_id, name, role, email, phone, notes';
const COLS = 'id, name, email, phone, billing_address, notes, markup_bp, created_at, updated_at';

export async function listCustomers(
  tx: Tx,
  query: z.output<typeof listQuery>,
): Promise<Page<CustomerDto>> {
  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const where = pattern
    ? tx`archived_at IS NULL AND (name ILIKE ${pattern} OR email ILIKE ${pattern} OR phone ILIKE ${pattern})`
    : tx`archived_at IS NULL`;
  const rows = await tx<(CustomerRow & { total: number })[]>`
    SELECT ${tx.unsafe(COLS)}, count(*) OVER ()::int AS total
      FROM customers WHERE ${where}
     ORDER BY lower(name), id
     LIMIT ${query.limit} OFFSET ${query.offset}`;
  return { items: rows.map(toCustomer), total: rows[0]?.total ?? 0 };
}

export async function getCustomer(tx: Tx, id: string): Promise<CustomerDetailDto> {
  const [row] = await tx<CustomerRow[]>`SELECT ${tx.unsafe(COLS)} FROM customers WHERE id = ${id}`;
  if (!row) throw notFound('Customer');
  const sites = await tx<SiteDto[]>`
    SELECT id, customer_id, label, address, notes FROM sites WHERE customer_id = ${id} ORDER BY created_at, id`;
  const contacts = await tx<ContactDto[]>`
    SELECT ${tx.unsafe(CONTACT_COLS)} FROM contacts WHERE customer_id = ${id} ORDER BY created_at, id`;
  const [quotes, jobs] = [
    await listQuotes(tx, { limit: 200, offset: 0, customerId: id }),
    await listJobs(tx, { limit: 200, offset: 0, customerId: id }),
  ];
  return {
    ...toCustomer(row),
    sites: sites.map(toSite),
    contacts: [...contacts],
    quotes: quotes.items,
    jobs: jobs.items,
  };
}

export async function createCustomer(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof customerCreate>,
): Promise<CustomerDetailDto> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO customers (tenant_id, name, email, phone, billing_address, notes, markup_bp)
    VALUES (${auth.tenantId}, ${input.name}, ${input.email}, ${input.phone}, ${input.billingAddress}, ${input.notes}, ${input.markupBp})
    RETURNING id`;
  const siteIds: string[] = [];
  for (const site of input.sites) {
    const [s] = await tx<
      { id: string }[]
    >`INSERT INTO sites (tenant_id, customer_id, label, address, notes)
             VALUES (${auth.tenantId}, ${row!.id}, ${site.label}, ${site.address}, ${site.notes}) RETURNING id`;
    siteIds.push(s!.id);
  }
  for (const c of input.contacts) {
    const siteId = c.siteIndex == null ? null : siteIds[c.siteIndex];
    if (siteId === undefined)
      throw invalid('A contact refers to a site that is not in this customer', {
        fields: { contacts: 'Unknown site' },
      });
    await tx`INSERT INTO contacts (tenant_id, customer_id, site_id, name, role, email, phone, notes)
             VALUES (${auth.tenantId}, ${row!.id}, ${siteId}, ${c.name}, ${c.role}, ${c.email}, ${c.phone}, ${c.notes})`;
  }
  await audit(tx, auth, 'create', 'customer', row!.id, { name: input.name });
  return getCustomer(tx, row!.id);
}

export async function updateCustomer(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof customerUpdate>,
): Promise<CustomerDetailDto> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.billingAddress !== undefined) patch.billing_address = input.billingAddress;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.markupBp !== undefined) patch.markup_bp = input.markupBp;
  if (Object.keys(patch).length) {
    const r = await tx`UPDATE customers SET ${tx(patch)} WHERE id = ${id}`;
    if (r.count === 0) throw notFound('Customer');
    await audit(tx, auth, 'update', 'customer', id, { fields: Object.keys(patch) });
  }
  return getCustomer(tx, id);
}

export async function addSite(
  tx: Tx,
  auth: Auth,
  customerId: string,
  input: z.output<typeof siteInput>,
): Promise<SiteDto> {
  const [exists] = await tx`SELECT 1 FROM customers WHERE id = ${customerId}`;
  if (!exists) throw notFound('Customer');
  const [row] = await tx<SiteDto[]>`
    INSERT INTO sites (tenant_id, customer_id, label, address, notes)
    VALUES (${auth.tenantId}, ${customerId}, ${input.label}, ${input.address}, ${input.notes})
    RETURNING id, customer_id, label, address, notes`;
  await audit(tx, auth, 'create', 'site', row!.id, { customerId });
  return toSite(row!);
}

export async function updateSite(
  tx: Tx,
  auth: Auth,
  id: string,
  input: Partial<z.output<typeof siteInput>>,
): Promise<SiteDto> {
  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) patch.label = input.label;
  if (input.address !== undefined) patch.address = input.address;
  if (input.notes !== undefined) patch.notes = input.notes;
  const [row] = Object.keys(patch).length
    ? await tx<
        SiteDto[]
      >`UPDATE sites SET ${tx(patch)} WHERE id = ${id} RETURNING id, customer_id, label, address, notes`
    : await tx<
        SiteDto[]
      >`SELECT id, customer_id, label, address, notes FROM sites WHERE id = ${id}`;
  if (!row) throw notFound('Site');
  if (Object.keys(patch).length)
    await audit(tx, auth, 'update', 'site', id, { fields: Object.keys(patch) });
  return toSite(row);
}

/** Ensures a site exists and belongs to the given customer. */
export async function assertSiteOfCustomer(
  tx: Tx,
  siteId: string | null,
  customerId: string,
): Promise<void> {
  if (!siteId) return;
  const [row] = await tx<
    { customerId: string }[]
  >`SELECT customer_id FROM sites WHERE id = ${siteId}`;
  if (!row) throw notFound('Site');
  if (row.customerId !== customerId) {
    throw invalid('That site belongs to a different customer', {
      fields: { siteId: 'Pick one of this customer’s sites' },
    });
  }
}

export async function addContact(
  tx: Tx,
  auth: Auth,
  customerId: string,
  input: z.output<typeof contactInput>,
): Promise<ContactDto> {
  const [exists] = await tx`SELECT 1 FROM customers WHERE id = ${customerId}`;
  if (!exists) throw notFound('Customer');
  await assertSiteOfCustomer(tx, input.siteId, customerId);
  const [row] = await tx<ContactDto[]>`
    INSERT INTO contacts (tenant_id, customer_id, site_id, name, role, email, phone, notes)
    VALUES (${auth.tenantId}, ${customerId}, ${input.siteId}, ${input.name}, ${input.role}, ${input.email}, ${input.phone}, ${input.notes})
    RETURNING ${tx.unsafe(CONTACT_COLS)}`;
  await audit(tx, auth, 'create', 'contact', row!.id, { customerId, role: input.role });
  return row!;
}

export async function updateContact(
  tx: Tx,
  auth: Auth,
  id: string,
  input: Partial<z.output<typeof contactInput>>,
): Promise<ContactDto> {
  const [current] = await tx<
    { customerId: string }[]
  >`SELECT customer_id FROM contacts WHERE id = ${id} FOR UPDATE`;
  if (!current) throw notFound('Contact');
  const patch: Record<string, unknown> = {};
  for (const [k, col] of [
    ['name', 'name'],
    ['role', 'role'],
    ['email', 'email'],
    ['phone', 'phone'],
    ['notes', 'notes'],
  ] as const) {
    if (input[k] !== undefined) patch[col] = input[k];
  }
  if (input.siteId !== undefined) {
    await assertSiteOfCustomer(tx, input.siteId, current.customerId);
    patch.site_id = input.siteId;
  }
  const [row] = Object.keys(patch).length
    ? await tx<
        ContactDto[]
      >`UPDATE contacts SET ${tx(patch)} WHERE id = ${id} RETURNING ${tx.unsafe(CONTACT_COLS)}`
    : await tx<ContactDto[]>`SELECT ${tx.unsafe(CONTACT_COLS)} FROM contacts WHERE id = ${id}`;
  if (Object.keys(patch).length)
    await audit(tx, auth, 'update', 'contact', id, { fields: Object.keys(patch) });
  return row!;
}

export async function deleteContact(tx: Tx, auth: Auth, id: string): Promise<void> {
  const r = await tx`DELETE FROM contacts WHERE id = ${id}`;
  if (r.count === 0) throw notFound('Contact');
  await audit(tx, auth, 'delete', 'contact', id);
}
