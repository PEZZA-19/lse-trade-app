/**
 * Preview version of enquiries and the approvals inbox. Same rules as the server
 * (apps/api/src/services/enquiries.ts and proposals.ts): helpers only draft, the owner decides,
 * approved emails wait two minutes (Stop puts them back), and with no email account connected
 * they end "not sent". Drafts come from the same deterministic fake model; no AI is called.
 */
import {
  EMAIL_KINDS,
  HOLD_SECONDS,
  enquiryConvert,
  enquiryCreate,
  enquiryReject,
  enquiryTitle,
  fakeAnswer,
  proposalEdit,
  type EmailPayload,
  type EnquiryDto,
  type PriceUpdatePayload,
  type ProposalDto,
  type ProposalEventDto,
  type ProposalKind,
  type QuoteDraftPayload,
} from '@lse/shared';
import type { z } from 'zod';

export interface InboxDb {
  enquiries: EnquiryDto[];
  proposals: (Omit<ProposalDto, 'events'> & { events: ProposalEventDto[] })[];
  formKey: string | null;
}
export const freshInbox = (): InboxDb => ({ enquiries: [], proposals: [], formKey: null });

export interface InboxCtx {
  db: InboxDb;
  call: (method: string, path: string, body?: unknown) => unknown;
  fail: (status: number, code: string, message: string, details?: unknown) => never;
  parse: <S extends z.ZodType>(schema: S, data: unknown) => z.output<S>;
  uid: () => string;
  now: () => string;
  userName: string;
  ifMatch: () => number | undefined;
}

const DONE = (s: EnquiryDto['status']) => s !== 'todo';

function release(c: InboxCtx) {
  for (const p of c.db.proposals)
    if (p.status === 'held' && p.holdUntil && new Date(p.holdUntil).getTime() <= Date.now()) {
      p.status = 'send_blocked';
      p.holdUntil = null;
      p.result = { sent: false, reason: 'No email account is connected, so nothing was sent.' };
      p.events.push({ event: 'send_blocked', byName: null, data: p.result, at: c.now() });
      p.version += 1;
    }
}

function customerFor(c: InboxCtx, e: EnquiryDto): string {
  if (e.customerId) return e.customerId;
  const list = c.call(
    'GET',
    `/customers?q=${encodeURIComponent(e.email ?? e.phone ?? e.name)}`,
  ) as {
    items: { id: string; email: string | null; phone: string | null }[];
  };
  const digits = (s: string | null) => s?.replace(/\D/g, '') ?? '';
  const hit = list.items.find(
    (x) =>
      (e.email && x.email?.toLowerCase() === e.email) ||
      (digits(e.phone).length >= 6 && digits(x.phone) === digits(e.phone)),
  );
  if (hit) return hit.id;
  const created = c.call('POST', '/customers', {
    name: e.name,
    email: e.email,
    phone: e.phone,
    billingAddress: e.address,
    notes: 'Added from an enquiry.',
  }) as { id: string };
  return created.id;
}

function convert(
  c: InboxCtx,
  e: EnquiryDto,
  input: z.output<typeof enquiryConvert>,
  lines: unknown[] = [],
  notes: string | null = null,
) {
  if (DONE(e.status)) c.fail(409, 'enquiry_done', 'This enquiry has already been dealt with.');
  const customerId = customerFor(c, e);
  const customer = c.call('GET', `/customers/${customerId}`) as { name: string };
  const title = input.title?.trim() || enquiryTitle(e.message);
  if (input.to === 'quote') {
    const q = c.call('POST', '/quotes', { customerId, title, notes, lines }) as { id: string };
    e.quoteId = q.id;
  } else {
    const j = c.call('POST', '/jobs', {
      customerId,
      title,
      description: e.message.slice(0, 4000),
    }) as { id: string };
    e.jobId = j.id;
    if (input.to === 'appointment') {
      c.call('POST', `/jobs/${j.id}/appointments`, {
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      });
      e.appointmentId = 'demo';
    }
  }
  Object.assign(e, {
    status: 'converted',
    convertedTo: input.to,
    customerId,
    customerName: customer.name,
    decidedByName: c.userName,
    decidedAt: c.now(),
    version: e.version + 1,
  });
  return e;
}

function addProposal(
  c: InboxCtx,
  p: {
    agent: string;
    kind: ProposalKind;
    title: string;
    summary: string;
    payload: ProposalDto['payload'];
    sourceType: string;
    sourceId: string;
    drafter: string | null;
  },
) {
  if (
    c.db.proposals.some(
      (x) =>
        x.kind === p.kind &&
        x.sourceId === p.sourceId &&
        (x.status === 'pending' || x.status === 'held'),
    )
  )
    c.fail(409, 'draft_exists', 'There is already a draft waiting for this in Approvals.');
  const row = {
    id: c.uid(),
    ...p,
    status: 'pending' as const,
    holdUntil: null,
    decidedByName: null,
    decidedAt: null,
    result: null,
    createdAt: c.now(),
    version: 1,
    events: [{ event: 'created' as const, byName: null, data: { agent: p.agent }, at: c.now() }],
  };
  c.db.proposals.push(row);
  return row;
}

function getEnquiry(c: InboxCtx, id: string) {
  return c.db.enquiries.find((e) => e.id === id) ?? c.fail(404, 'not_found', 'Enquiry not found');
}

export function inboxRoute(
  c: InboxCtx,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: unknown,
): unknown {
  const [a, id, sub] = seg;
  if (a === 'settings' && id === 'enquiry-form') {
    if (method === 'POST') {
      const { on } = body as { on: boolean };
      c.db.formKey = on ? c.uid().replace(/-/g, '').slice(0, 24) : null;
    }
    return {
      formKey: c.db.formKey,
      endpoint: c.db.formKey ? `/api/public/enquiries/${c.db.formKey}` : null,
    };
  }
  if (a === 'enquiries') {
    if (method === 'GET' && id === 'counts')
      return { todo: c.db.enquiries.filter((e) => e.status === 'todo').length };
    if (method === 'GET' && !id) {
      const done = query.get('status') === 'done';
      return c.db.enquiries
        .filter((e) => DONE(e.status) === done)
        .sort((x, y) =>
          done
            ? (y.decidedAt ?? '').localeCompare(x.decidedAt ?? '')
            : x.createdAt.localeCompare(y.createdAt),
        );
    }
    if (method === 'POST' && !id) {
      const input = c.parse(enquiryCreate, body);
      const e: EnquiryDto = {
        id: c.uid(),
        source: input.source,
        status: 'todo',
        name: input.name,
        email: input.email,
        phone: input.phone,
        address: input.address,
        message: input.message,
        customerId: null,
        customerName: null,
        convertedTo: null,
        quoteId: null,
        jobId: null,
        appointmentId: null,
        rejectReason: null,
        decidedByName: null,
        decidedAt: null,
        createdAt: c.now(),
        version: 1,
      };
      c.db.enquiries.push(e);
      return e;
    }
    const e = getEnquiry(c, id!);
    if (method === 'GET' && !sub) return e;
    if (method === 'POST' && (sub === 'actioned' || sub === 'reject')) {
      if (DONE(e.status)) c.fail(409, 'enquiry_done', 'This enquiry has already been dealt with.');
      const reason = sub === 'reject' ? c.parse(enquiryReject, body ?? {}).reason : null;
      Object.assign(e, {
        status: sub === 'reject' ? 'rejected' : 'actioned',
        rejectReason: reason,
        decidedByName: c.userName,
        decidedAt: c.now(),
        version: e.version + 1,
      });
      return e;
    }
    if (method === 'POST' && sub === 'convert') return convert(c, e, c.parse(enquiryConvert, body));
    if (method === 'POST' && sub === 'draft-reply') {
      if (!e.email)
        c.fail(422, 'validation_failed', 'This enquiry has no email address to reply to.');
      const m = fakeAnswer('reply_email', { customerName: e.name, message: e.message }) as {
        subject: string;
        body: string;
      };
      const payload: EmailPayload = { to: e.email!, toName: e.name, ...m };
      return addProposal(c, {
        agent: 'reply-helper',
        kind: 'reply_email',
        title: `Reply to ${e.name}`,
        summary: `Email ${e.name} <${e.email}>: “${m.subject}”. Sent 2 minutes after you approve, unless you tap Stop.`,
        payload,
        sourceType: 'enquiry',
        sourceId: e.id,
        drafter: 'fake',
      });
    }
    if (method === 'POST' && sub === 'draft-quote') {
      if (DONE(e.status)) c.fail(409, 'enquiry_done', 'This enquiry has already been dealt with.');
      const items = c.call('GET', '/price-list') as { id: string; description: string }[];
      const q = fakeAnswer('quote_draft', { message: e.message, items }) as {
        title: string;
        notes: string;
        lines: {
          itemId: string | null;
          kind: 'material' | 'labour';
          description: string;
          qty: number;
        }[];
      };
      const payload: QuoteDraftPayload = {
        enquiryId: e.id,
        customerName: e.name,
        title: q.title,
        notes: q.notes,
        lines: q.lines.map((l) => ({
          itemId: l.itemId,
          kind: l.kind,
          description: l.description,
          qtyMilli: Math.round(l.qty * 1000),
          unitPricePence: null,
        })),
      };
      return addProposal(c, {
        agent: 'quote-helper',
        kind: 'quote_draft',
        title: `Quote for ${e.name}`,
        summary: `Create a draft quote “${q.title}” for ${e.name} with ${payload.lines.length} lines, and mark the enquiry converted. Nothing is sent.`,
        payload,
        sourceType: 'enquiry',
        sourceId: e.id,
        drafter: 'fake',
      });
    }
    return undefined;
  }
  if (a === 'supplier-bills' && sub === 'suggest-prices' && method === 'POST') {
    const bill = c.call('GET', `/supplier-bills/${id}`) as {
      supplierName: string;
      reference: string;
      status: string;
    };
    const preview = c.call('POST', `/supplier-bills/${id}/apply`, { dryRun: true }) as {
      priceChanges: { description: string; oldCostPence: number | null; newCostPence: number }[];
      jobNumber: string | null;
      jobLines: unknown[];
    };
    if (!preview.priceChanges.length)
      c.fail(
        422,
        'validation_failed',
        'Nothing to update: every matched line already has the list cost.',
      );
    const payload: PriceUpdatePayload = {
      billId: id!,
      billLabel: `${bill.supplierName} ${bill.reference}`,
      changes: preview.priceChanges.map((x) => ({
        description: x.description,
        oldCostPence: x.oldCostPence,
        newCostPence: x.newCostPence,
      })),
      jobNumber: preview.jobNumber,
      jobLines: preview.jobLines.length,
    };
    return addProposal(c, {
      agent: 'price-watcher',
      kind: 'price_update',
      title: `Prices from ${payload.billLabel}`,
      summary: `Apply bill ${payload.billLabel}: update ${payload.changes.length} list costs (kits recalculated)${payload.jobNumber ? ` and add ${payload.jobLines} lines to job ${payload.jobNumber}` : ''}.`,
      payload,
      sourceType: 'supplier_bill',
      sourceId: id!,
      drafter: null,
    });
  }
  if (a !== 'proposals') return undefined;
  release(c);
  if (method === 'GET' && id === 'counts')
    return {
      pending: c.db.proposals.filter((p) => p.status === 'pending').length,
      held: c.db.proposals.filter((p) => p.status === 'held').length,
    };
  if (method === 'GET' && !id) {
    const open = query.get('status') !== 'done';
    return c.db.proposals
      .filter((p) => (p.status === 'pending' || p.status === 'held') === open)
      .map(({ events: _events, ...p }) => p);
  }
  if (method === 'POST' && id === 'overdue-reminders') {
    const overdue = c.call('GET', '/invoices?filter=overdue') as {
      id: string;
      number: string;
      dueDate: string;
      balancePence: number;
      customerName: string;
      jobId: string;
    }[];
    const created: ProposalDto[] = [];
    const skipped: string[] = [];
    for (const inv of overdue) {
      if (
        c.db.proposals.some(
          (p) =>
            p.kind === 'overdue_reminder' &&
            p.sourceId === inv.id &&
            (p.status === 'pending' || p.status === 'held'),
        )
      )
        continue;
      const job = c.call('GET', `/jobs/${inv.jobId}`) as { customerId: string };
      const cust = c.call('GET', `/customers/${job.customerId}`) as { email: string | null };
      if (!cust.email) {
        skipped.push(`${inv.number}: ${inv.customerName} has no email address`);
        continue;
      }
      const days = Math.max(
        1,
        Math.round((Date.now() - new Date(`${inv.dueDate}T12:00:00Z`).getTime()) / 86_400_000),
      );
      const m = fakeAnswer('overdue_reminder', {
        customerName: inv.customerName,
        invoiceNumber: inv.number,
        amountPence: inv.balancePence,
        dueDate: inv.dueDate,
        daysOverdue: days,
      }) as { subject: string; body: string };
      created.push(
        addProposal(c, {
          agent: 'reminder-helper',
          kind: 'overdue_reminder',
          title: `Reminder: invoice ${inv.number}`,
          summary: `Email ${inv.customerName} <${cust.email}> about invoice ${inv.number} (${(inv.balancePence / 100).toFixed(2)} overdue ${days} ${days === 1 ? 'day' : 'days'}). Sent 2 minutes after you approve, unless you tap Stop.`,
          payload: { to: cust.email, toName: inv.customerName, ...m },
          sourceType: 'invoice',
          sourceId: inv.id,
          drafter: 'fake',
        }),
      );
    }
    return { created, skipped };
  }
  const p =
    c.db.proposals.find((x) => x.id === id) ?? c.fail(404, 'not_found', 'Proposal not found');
  if (method === 'GET') return p;
  const expected = c.ifMatch();
  if (sub !== 'stop' && expected !== undefined && expected !== p.version)
    c.fail(409, 'version_conflict', 'This was changed on another device since you edited it.', {
      currentVersion: p.version,
      current: p,
    });
  const log = (
    event: ProposalEventDto['event'],
    data: unknown = null,
    by: string | null = c.userName,
  ) => p.events.push({ event, byName: by, data, at: c.now() });
  if (method === 'PATCH') {
    if (p.status !== 'pending') c.fail(409, 'not_pending', 'Only a waiting draft can be edited.');
    const patch = c.parse(proposalEdit, body);
    const before = p.payload;
    p.payload = { ...p.payload, ...patch } as ProposalDto['payload'];
    log('edited', { before, after: p.payload });
  } else if (sub === 'discard') {
    if (p.status !== 'pending')
      c.fail(409, 'not_pending', 'Only a waiting draft can be discarded.');
    Object.assign(p, { status: 'discarded', decidedByName: c.userName, decidedAt: c.now() });
    log('discarded');
  } else if (sub === 'stop') {
    if (p.status !== 'held' || !p.holdUntil || new Date(p.holdUntil).getTime() <= Date.now())
      c.fail(
        409,
        'too_late',
        'Too late to stop: the two minutes are up (or it was never approved).',
      );
    Object.assign(p, { status: 'pending', holdUntil: null, decidedByName: null, decidedAt: null });
    log('stopped');
  } else if (sub === 'approve') {
    if (p.status !== 'pending') c.fail(409, 'not_pending', 'This draft has already been decided.');
    if (EMAIL_KINDS.includes(p.kind)) {
      Object.assign(p, {
        status: 'held',
        holdUntil: new Date(Date.now() + HOLD_SECONDS * 1000).toISOString(),
        decidedByName: c.userName,
        decidedAt: c.now(),
      });
      log('approved', { holdSeconds: HOLD_SECONDS });
    } else {
      let result: unknown;
      if (p.kind === 'quote_draft') {
        const q = p.payload as QuoteDraftPayload;
        const items = c.call('GET', '/price-list') as {
          id: string;
          unitCostPence: number;
          markupBp: number | null;
        }[];
        const lines = q.lines.map((l) => {
          const i = items.find((x) => x.id === l.itemId);
          return {
            kind: l.kind,
            description: l.description,
            qtyMilli: l.qtyMilli,
            unitCostPence: i?.unitCostPence ?? null,
            markupBp: i?.markupBp ?? null,
            unitPricePence: l.unitPricePence,
          };
        });
        const e = convert(
          c,
          getEnquiry(c, q.enquiryId),
          { to: 'quote', title: q.title },
          lines,
          q.notes || null,
        );
        result = { quoteId: e.quoteId, customerId: e.customerId };
      } else {
        const u = p.payload as PriceUpdatePayload;
        const r = c.call('POST', `/supplier-bills/${u.billId}/apply`, { dryRun: false }) as {
          priceChanges: unknown[];
          jobLines: unknown[];
        };
        result = {
          billId: u.billId,
          priceChanges: r.priceChanges.length,
          jobLines: r.jobLines.length,
        };
      }
      Object.assign(p, {
        status: 'applied',
        decidedByName: c.userName,
        decidedAt: c.now(),
        result,
      });
      log('approved');
      log('applied', result);
    }
  } else return undefined;
  p.version += 1;
  return p;
}
