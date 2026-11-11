/**
 * Enquiries: To Do until someone converts, actions or rejects them. Converting finds the
 * customer by email or phone (or adds them) and creates a draft quote, a job, or a job with an
 * appointment. Nothing is sent to the enquirer from here.
 */
import {
  enquiryTitle,
  type EnquiryDto,
  type EnquiryFormDto,
  type enquiryConvert,
  type enquiryCreate,
} from '@lse/shared';
import type { z } from 'zod';
import type { Tx } from '../db/client';
import { assertVersion, conflict, notFound } from '../lib/errors';
import { iso, isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { createCustomer } from './customers';
import { createAppointment, createJob } from './jobs';
import { createQuote } from './quotes';

interface Row {
  id: string;
  source: EnquiryDto['source'];
  status: EnquiryDto['status'];
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  message: string;
  customerId: string | null;
  customerName: string | null;
  convertedTo: EnquiryDto['convertedTo'];
  quoteId: string | null;
  jobId: string | null;
  appointmentId: string | null;
  rejectReason: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  version: number;
}

const SELECT = (tx: Tx) => tx`
  SELECT e.id, e.source, e.status, e.name, e.email, e.phone, e.address, e.message, e.customer_id,
         c.name AS customer_name, e.converted_to, e.quote_id, e.job_id, e.appointment_id,
         e.reject_reason, u.name AS decided_by_name, e.decided_at, e.created_at, e.version
    FROM enquiries e
    LEFT JOIN customers c ON c.id = e.customer_id
    LEFT JOIN users u ON u.id = e.decided_by`;

const toDto = (r: Row): EnquiryDto => ({
  ...r,
  decidedAt: iso(r.decidedAt),
  createdAt: isoNN(r.createdAt),
});

export async function listEnquiries(tx: Tx, which: 'todo' | 'done'): Promise<EnquiryDto[]> {
  const rows = await tx<Row[]>`
    ${SELECT(tx)}
     WHERE ${which === 'todo' ? tx`e.status = 'todo'` : tx`e.status <> 'todo'`}
     ORDER BY ${which === 'todo' ? tx`e.created_at` : tx`e.decided_at DESC`}
     LIMIT 200`;
  return rows.map(toDto);
}

export async function getEnquiry(tx: Tx, id: string): Promise<EnquiryDto> {
  const [r] = await tx<Row[]>`${SELECT(tx)} WHERE e.id = ${id}`;
  if (!r) throw notFound('Enquiry');
  return toDto(r);
}

export async function enquiryCounts(tx: Tx) {
  const [r] = await tx<
    { todo: string }[]
  >`SELECT count(*) AS todo FROM enquiries WHERE status = 'todo'`;
  return { todo: Number(r!.todo) };
}

export async function createEnquiry(
  tx: Tx,
  auth: Auth,
  input: z.output<typeof enquiryCreate>,
): Promise<EnquiryDto> {
  const [r] = await tx<{ id: string }[]>`
    INSERT INTO enquiries (tenant_id, source, name, email, phone, address, message, created_by)
    VALUES (${auth.tenantId}, ${input.source}, ${input.name}, ${input.email}, ${input.phone},
            ${input.address}, ${input.message}, ${auth.userId})
    RETURNING id`;
  await audit(tx, auth, 'create', 'enquiry', r!.id, { source: input.source });
  return getEnquiry(tx, r!.id);
}

async function lockTodo(tx: Tx, id: string, expectedVersion?: number) {
  const [cur] = await tx<Row[]>`${SELECT(tx)} WHERE e.id = ${id} FOR UPDATE OF e`;
  if (!cur) throw notFound('Enquiry');
  await assertVersion(expectedVersion, cur.version, () => getEnquiry(tx, id));
  if (cur.status !== 'todo')
    throw conflict('enquiry_done', 'This enquiry has already been dealt with.');
  return cur;
}

export async function markActioned(tx: Tx, auth: Auth, id: string, v?: number) {
  await lockTodo(tx, id, v);
  await tx`UPDATE enquiries SET status = 'actioned', decided_by = ${auth.userId}, decided_at = now() WHERE id = ${id}`;
  await audit(tx, auth, 'actioned', 'enquiry', id, {});
  return getEnquiry(tx, id);
}

export async function reject(tx: Tx, auth: Auth, id: string, reason: string | null, v?: number) {
  await lockTodo(tx, id, v);
  await tx`UPDATE enquiries SET status = 'rejected', reject_reason = ${reason}, decided_by = ${auth.userId}, decided_at = now() WHERE id = ${id}`;
  await audit(tx, auth, 'rejected', 'enquiry', id, { reason });
  return getEnquiry(tx, id);
}

/** Same email, else same phone (digits only), else a new customer. */
async function customerFor(tx: Tx, auth: Auth, e: Row): Promise<string> {
  if (e.customerId) return e.customerId;
  if (e.email) {
    const [c] = await tx<{ id: string }[]>`
      SELECT id FROM customers WHERE archived_at IS NULL AND lower(email) = ${e.email} ORDER BY created_at LIMIT 1`;
    if (c) return c.id;
  }
  const digits = e.phone?.replace(/\D/g, '') ?? '';
  if (digits.length >= 6) {
    const [c] = await tx<{ id: string }[]>`
      SELECT id FROM customers WHERE archived_at IS NULL AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = ${digits}
       ORDER BY created_at LIMIT 1`;
    if (c) return c.id;
  }
  const created = await createCustomer(tx, auth, {
    name: e.name,
    email: e.email,
    phone: e.phone,
    billingAddress: e.address,
    notes: 'Added from an enquiry.',
    markupBp: null,
    sites: [],
    contacts: [],
  } as never);
  return created.id;
}

export async function convert(
  tx: Tx,
  auth: Auth,
  id: string,
  input: z.output<typeof enquiryConvert>,
  v?: number,
  /** From an approved quote draft: its lines and notes. */
  quoteExtras?: { lines: unknown[]; notes: string | null },
): Promise<EnquiryDto> {
  const e = await lockTodo(tx, id, v);
  const customerId = await customerFor(tx, auth, e);
  const title = input.title?.trim() || enquiryTitle(e.message);
  let quoteId: string | null = null;
  let jobId: string | null = null;
  let appointmentId: string | null = null;
  if (input.to === 'quote') {
    const q = await createQuote(tx, auth, {
      customerId,
      siteId: null,
      title,
      notes: quoteExtras?.notes ?? null,
      validDays: 30,
      lines: quoteExtras?.lines ?? [],
    } as never);
    quoteId = q.id;
  } else {
    const j = await createJob(tx, auth, {
      customerId,
      siteId: null,
      title,
      description: e.message.slice(0, 4000),
      placeOfWork: 'sark',
    } as never);
    jobId = j.id;
    if (input.to === 'appointment') {
      await createAppointment(tx, auth, j.id, {
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        userId: null,
      } as never);
      const [a] = await tx<{ id: string }[]>`
        SELECT id FROM appointments WHERE job_id = ${j.id} ORDER BY starts_at DESC LIMIT 1`;
      appointmentId = a!.id;
    }
  }
  await tx`
    UPDATE enquiries SET status = 'converted', converted_to = ${input.to}, customer_id = ${customerId},
           quote_id = ${quoteId}, job_id = ${jobId}, appointment_id = ${appointmentId},
           decided_by = ${auth.userId}, decided_at = now()
     WHERE id = ${id}`;
  await audit(tx, auth, 'converted', 'enquiry', id, {
    to: input.to,
    quoteId,
    jobId,
    appointmentId,
  });
  return getEnquiry(tx, id);
}

/* ------------------------------ website form ------------------------------ */

export const ENQUIRY_ENDPOINT = (key: string) => `/api/public/enquiries/${key}`;

export async function getForm(tx: Tx): Promise<EnquiryFormDto> {
  const [t] = await tx<
    { key: string | null }[]
  >`SELECT enquiry_form_key AS key FROM tenants WHERE id = app_current_tenant()`;
  return { formKey: t?.key ?? null, endpoint: t?.key ? ENQUIRY_ENDPOINT(t.key) : null };
}

/** New key (the old one stops working), or null to switch the form off. */
export async function setForm(tx: Tx, auth: Auth, on: boolean): Promise<EnquiryFormDto> {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const key = on
    ? btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    : null;
  await tx`UPDATE tenants SET enquiry_form_key = ${key}, updated_at = now() WHERE id = app_current_tenant()`;
  await audit(
    tx,
    auth,
    on ? 'enquiry_form_key_set' : 'enquiry_form_off',
    'tenant',
    auth.tenantId,
    {},
  );
  return getForm(tx);
}
