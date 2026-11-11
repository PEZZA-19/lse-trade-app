/**
 * Approvals inbox. Helpers create proposals; only the owner decides. Every proposal and every
 * decision is written to proposal_events (and the audit log); every model call to ai_calls.
 *
 * Helpers here can't send, pay or delete. Approving an email holds it for two minutes (Stop
 * puts it back to pending); after that the release step hands it to the MessageSender, or marks
 * it "not sent" when no email account is connected (the case today).
 */
import {
  EMAIL_KINDS,
  HOLD_SECONDS,
  quoteLineInput,
  type EmailPayload,
  type PriceUpdatePayload,
  type ProposalCountsDto,
  type ProposalDto,
  type ProposalKind,
  type QuoteDraftPayload,
  type proposalEdit,
} from '@lse/shared';
import type { z } from 'zod';
import type { AiGateway } from '../ai/gateway';
import {
  emailAnswer,
  QUOTE_SYSTEM,
  quoteAnswer,
  REMINDER_SYSTEM,
  REPLY_SYSTEM,
} from '../ai/prompts';
import type { Tx } from '../db/client';
import { AppError, conflict, invalid, notFound, assertVersion } from '../lib/errors';
import type { MessageSender } from '../lib/messages';
import { iso, isoNN, type Auth } from '../lib/types';
import { audit } from './audit';
import { applyBill, getBill } from './bills';
import * as enquiries from './enquiries';
import { assertOwnerDecision } from './invoices';

interface Row {
  id: string;
  agent: string;
  kind: ProposalKind;
  status: ProposalDto['status'];
  title: string;
  summary: string;
  payload: ProposalDto['payload'];
  sourceType: string | null;
  sourceId: string | null;
  drafter: string | null;
  holdUntil: Date | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  result: unknown;
  createdAt: Date;
  version: number;
}

const SELECT = (tx: Tx) => tx`
  SELECT p.id, p.agent, p.kind, p.status, p.title, p.summary, p.payload, p.source_type, p.source_id,
         a.provider AS drafter, p.hold_until, u.name AS decided_by_name, p.decided_at, p.result,
         p.created_at, p.version
    FROM proposals p
    LEFT JOIN ai_calls a ON a.id = p.ai_call_id
    LEFT JOIN users u ON u.id = p.decided_by`;

const toDto = (r: Row): ProposalDto => ({
  ...r,
  holdUntil: iso(r.holdUntil),
  decidedAt: iso(r.decidedAt),
  createdAt: isoNN(r.createdAt),
});

async function event(tx: Tx, auth: Auth | null, id: string, ev: string, data: unknown = null) {
  await tx`
    INSERT INTO proposal_events (tenant_id, proposal_id, event, by_user, data)
    VALUES (app_current_tenant(), ${id}, ${ev}, ${auth?.userId ?? null}, ${data === null ? null : tx.json(data as never)})`;
}

/* --------------------------------- release -------------------------------- */

/** Emails whose two minutes are up go to the sender (or are marked not sent). */
export async function releaseDue(tx: Tx, sender: MessageSender | null): Promise<number> {
  const due = await tx<{ id: string; payload: EmailPayload; decidedBy: string }[]>`
    SELECT id, payload, decided_by FROM proposals
     WHERE status = 'held' AND hold_until <= now()
     ORDER BY hold_until FOR UPDATE SKIP LOCKED`;
  for (const p of due) {
    if (!sender) {
      const result = { sent: false, reason: 'No email account is connected, so nothing was sent.' };
      await tx`UPDATE proposals SET status = 'send_blocked', hold_until = NULL, result = ${tx.json(result)} WHERE id = ${p.id}`;
      await event(tx, null, p.id, 'send_blocked', result);
      continue;
    }
    try {
      const messageId = await sender.send(p.payload);
      const result = { sent: true, via: sender.name, messageId };
      await tx`UPDATE proposals SET status = 'sent', hold_until = NULL, result = ${tx.json(result)} WHERE id = ${p.id}`;
      await event(tx, null, p.id, 'sent', result);
    } catch (e) {
      const result = {
        sent: false,
        reason: `The email could not be sent: ${String((e as Error).message).slice(0, 200)}`,
      };
      await tx`UPDATE proposals SET status = 'send_blocked', hold_until = NULL, result = ${tx.json(result)} WHERE id = ${p.id}`;
      await event(tx, null, p.id, 'send_blocked', result);
    }
  }
  return due.length;
}

/* ---------------------------------- reads --------------------------------- */

export async function listProposals(tx: Tx, which: 'open' | 'done'): Promise<ProposalDto[]> {
  const rows = await tx<Row[]>`
    ${SELECT(tx)}
     WHERE ${which === 'open' ? tx`p.status IN ('pending', 'held')` : tx`p.status NOT IN ('pending', 'held')`}
     ORDER BY ${which === 'open' ? tx`p.created_at` : tx`coalesce(p.decided_at, p.updated_at) DESC`}
     LIMIT 200`;
  return rows.map(toDto);
}

export async function getProposal(tx: Tx, id: string): Promise<ProposalDto> {
  const [r] = await tx<Row[]>`${SELECT(tx)} WHERE p.id = ${id}`;
  if (!r) throw notFound('Proposal');
  const events = await tx<{ event: never; byName: string | null; data: unknown; at: Date }[]>`
    SELECT e.event, u.name AS by_name, e.data, e.created_at AS at
      FROM proposal_events e LEFT JOIN users u ON u.id = e.by_user
     WHERE e.proposal_id = ${id} ORDER BY e.created_at, e.id`;
  return { ...toDto(r), events: events.map((e) => ({ ...e, at: isoNN(e.at) })) };
}

export async function counts(tx: Tx): Promise<ProposalCountsDto> {
  const [r] = await tx<{ pending: string; held: string }[]>`
    SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
           count(*) FILTER (WHERE status = 'held') AS held
      FROM proposals`;
  return { pending: Number(r!.pending), held: Number(r!.held) };
}

/* --------------------------------- helpers -------------------------------- */

async function insert(
  tx: Tx,
  auth: Auth,
  p: {
    agent: string;
    kind: ProposalKind;
    title: string;
    summary: string;
    payload: unknown;
    sourceType: string;
    sourceId: string;
    aiCallId: string | null;
  },
): Promise<ProposalDto> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO proposals (tenant_id, agent, kind, title, summary, payload, source_type, source_id, ai_call_id)
    VALUES (${auth.tenantId}, ${p.agent}, ${p.kind}, ${p.title.slice(0, 200)}, ${p.summary.slice(0, 1000)},
            ${tx.json(p.payload as never)}, ${p.sourceType}, ${p.sourceId}, ${p.aiCallId})
    ON CONFLICT (tenant_id, kind, source_id) WHERE status IN ('pending', 'held') AND source_id IS NOT NULL DO NOTHING
    RETURNING id`;
  if (!row)
    throw conflict('draft_exists', 'There is already a draft waiting for this in Approvals.');
  await event(tx, auth, row.id, 'created', { agent: p.agent });
  await audit(tx, auth, 'proposal_created', 'proposal', row.id, {
    kind: p.kind,
    source: p.sourceId,
  });
  return getProposal(tx, row.id);
}

const aiFailed = (msg: string) => new AppError(503, 'ai_unavailable', msg);

export async function draftReply(tx: Tx, auth: Auth, ai: AiGateway, enquiryId: string) {
  const e = await enquiries.getEnquiry(tx, enquiryId);
  if (!e.email) throw invalid('This enquiry has no email address to reply to.');
  const res = await ai.run(
    tx,
    auth,
    {
      purpose: 'reply_email',
      system: REPLY_SYSTEM,
      input: { customerName: e.name, message: e.message },
    },
    emailAnswer,
  );
  if (!res.ok) throw aiFailed(res.error);
  const payload: EmailPayload = { to: e.email, toName: e.name, ...res.data };
  return insert(tx, auth, {
    agent: 'reply-helper',
    kind: 'reply_email',
    title: `Reply to ${e.name}`,
    summary: `Email ${e.name} <${e.email}>: “${payload.subject}”. Sent 2 minutes after you approve, unless you tap Stop.`,
    payload,
    sourceType: 'enquiry',
    sourceId: e.id,
    aiCallId: res.callId,
  });
}

export async function draftQuote(tx: Tx, auth: Auth, ai: AiGateway, enquiryId: string) {
  const e = await enquiries.getEnquiry(tx, enquiryId);
  if (e.status !== 'todo')
    throw conflict('enquiry_done', 'This enquiry has already been dealt with.');
  const items = await tx<
    {
      id: string;
      description: string;
      unitCostPence: number;
      markupBp: number | null;
      sellPricePence: number | null;
    }[]
  >`
    SELECT id, description, unit_cost_pence, markup_bp, sell_price_pence FROM price_list_items
     WHERE is_active ORDER BY updated_at DESC LIMIT 300`;
  const res = await ai.run(
    tx,
    auth,
    {
      purpose: 'quote_draft',
      system: QUOTE_SYSTEM,
      input: {
        message: e.message,
        items: items.map((i) => ({ id: i.id, description: i.description })),
      },
    },
    quoteAnswer,
  );
  if (!res.ok) throw aiFailed(res.error);
  const known = new Map(items.map((i) => [i.id, i]));
  const lines = res.data.lines
    // Only items that really are on the price list; a made-up id becomes a plain line.
    .map((l) => ({
      itemId: l.itemId && known.has(l.itemId) ? l.itemId : null,
      kind: l.kind,
      description: l.description,
      qtyMilli: Math.max(1, Math.round(l.qty * 1000)),
      unitPricePence: null,
    }));
  const payload: QuoteDraftPayload = {
    enquiryId: e.id,
    customerName: e.name,
    title: res.data.title,
    lines,
    notes: res.data.notes,
  };
  return insert(tx, auth, {
    agent: 'quote-helper',
    kind: 'quote_draft',
    title: `Quote for ${e.name}`,
    summary: `Create a draft quote “${payload.title}” for ${e.name} with ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}, and mark the enquiry converted. Nothing is sent.`,
    payload,
    sourceType: 'enquiry',
    sourceId: e.id,
    aiCallId: res.callId,
  });
}

/** One reminder draft per overdue invoice with an email address and no open draft already. */
export async function draftOverdueReminders(tx: Tx, auth: Auth, ai: AiGateway) {
  const rows = await tx<
    {
      id: string;
      number: string;
      dueDate: string;
      balance: string;
      customerName: string;
      email: string | null;
      days: number;
    }[]
  >`
    SELECT v.id, v.number, v.due_date::text AS due_date, (v.total_pence - v.paid_pence - v.credited_pence) AS balance,
           c.name AS customer_name, c.email, (current_date - v.due_date) AS days
      FROM invoices v JOIN jobs j ON j.id = v.job_id JOIN customers c ON c.id = j.customer_id
     WHERE v.status IN ('sent', 'part_paid') AND v.due_date < current_date
       AND v.total_pence - v.paid_pence - v.credited_pence > 0
       AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.kind = 'overdue_reminder' AND p.source_id = v.id AND p.status IN ('pending', 'held'))
     ORDER BY v.due_date`;
  const created: ProposalDto[] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    if (!r.email) {
      skipped.push(`${r.number}: ${r.customerName} has no email address`);
      continue;
    }
    const amountPence = Number(r.balance);
    const res = await ai.run(
      tx,
      auth,
      {
        purpose: 'overdue_reminder',
        system: REMINDER_SYSTEM,
        input: {
          customerName: r.customerName,
          invoiceNumber: r.number,
          amountPence,
          dueDate: r.dueDate,
          daysOverdue: r.days,
        },
      },
      emailAnswer,
    );
    if (!res.ok) throw aiFailed(res.error);
    created.push(
      await insert(tx, auth, {
        agent: 'reminder-helper',
        kind: 'overdue_reminder',
        title: `Reminder: invoice ${r.number}`,
        summary: `Email ${r.customerName} <${r.email}> about invoice ${r.number} (${(amountPence / 100).toFixed(2)} overdue ${r.days} ${r.days === 1 ? 'day' : 'days'}). Sent 2 minutes after you approve, unless you tap Stop.`,
        payload: { to: r.email, toName: r.customerName, ...res.data } satisfies EmailPayload,
        sourceType: 'invoice',
        sourceId: r.id,
        aiCallId: res.callId,
      }),
    );
  }
  return { created, skipped };
}

/** Rule-based (no model): what applying a draft bill would change on the price list. */
export async function suggestPriceUpdates(tx: Tx, auth: Auth, billId: string) {
  const bill = await getBill(tx, billId);
  if (bill.status !== 'draft')
    throw conflict('bill_applied', 'This bill has already been applied.');
  const preview = await applyBill(tx, auth, billId, true);
  if (!preview.priceChanges.length)
    throw invalid('Nothing to update: every matched line already has the list cost.');
  const payload: PriceUpdatePayload = {
    billId,
    billLabel: `${bill.supplierName} ${bill.reference}`,
    changes: preview.priceChanges.map((c) => ({
      description: c.description,
      oldCostPence: c.oldCostPence,
      newCostPence: c.newCostPence,
    })),
    jobNumber: preview.jobNumber,
    jobLines: preview.jobLines.length,
  };
  return insert(tx, auth, {
    agent: 'price-watcher',
    kind: 'price_update',
    title: `Prices from ${payload.billLabel}`,
    summary: `Apply bill ${payload.billLabel}: update ${payload.changes.length} list ${payload.changes.length === 1 ? 'cost' : 'costs'} (kits recalculated)${payload.jobNumber ? ` and add ${payload.jobLines} lines to job ${payload.jobNumber}` : ''}.`,
    payload,
    sourceType: 'supplier_bill',
    sourceId: billId,
    aiCallId: null,
  });
}

/* -------------------------------- decisions ------------------------------- */

async function lock(tx: Tx, id: string, expectedVersion?: number) {
  const [p] = await tx<Row[]>`${SELECT(tx)} WHERE p.id = ${id} FOR UPDATE OF p`;
  if (!p) throw notFound('Proposal');
  await assertVersion(expectedVersion, p.version, () => getProposal(tx, id));
  return p;
}

export async function edit(
  tx: Tx,
  auth: Auth,
  id: string,
  patch: z.output<typeof proposalEdit>,
  v?: number,
) {
  assertOwnerDecision(auth, 'edit a draft');
  const p = await lock(tx, id, v);
  if (p.status !== 'pending') throw conflict('not_pending', 'Only a waiting draft can be edited.');
  const isEmail = EMAIL_KINDS.includes(p.kind);
  if (isEmail !== 'subject' in patch || p.kind === 'price_update')
    throw invalid('Those changes don’t fit this kind of draft.');
  const payload = { ...p.payload, ...patch };
  await tx`UPDATE proposals SET payload = ${tx.json(payload as never)} WHERE id = ${id}`;
  await event(tx, auth, id, 'edited', { before: p.payload, after: payload });
  await audit(tx, auth, 'proposal_edited', 'proposal', id, {});
  return getProposal(tx, id);
}

export async function discard(tx: Tx, auth: Auth, id: string, v?: number) {
  assertOwnerDecision(auth, 'discard a draft');
  const p = await lock(tx, id, v);
  if (p.status !== 'pending')
    throw conflict('not_pending', 'Only a waiting draft can be discarded.');
  await tx`UPDATE proposals SET status = 'discarded', decided_by = ${auth.userId}, decided_at = now() WHERE id = ${id}`;
  await event(tx, auth, id, 'discarded');
  await audit(tx, auth, 'proposal_discarded', 'proposal', id, {});
  return getProposal(tx, id);
}

export async function approve(
  tx: Tx,
  auth: Auth,
  id: string,
  v?: number,
  holdSeconds = HOLD_SECONDS,
) {
  assertOwnerDecision(auth, 'approve a draft');
  const p = await lock(tx, id, v);
  if (p.status !== 'pending') throw conflict('not_pending', 'This draft has already been decided.');
  if (EMAIL_KINDS.includes(p.kind)) {
    await tx`
      UPDATE proposals SET status = 'held', hold_until = now() + make_interval(secs => ${holdSeconds}),
             decided_by = ${auth.userId}, decided_at = now()
       WHERE id = ${id}`;
    await event(tx, auth, id, 'approved', { holdSeconds });
    await audit(tx, auth, 'proposal_approved', 'proposal', id, { kind: p.kind });
    return getProposal(tx, id);
  }
  let result: unknown;
  if (p.kind === 'quote_draft') {
    const q = p.payload as QuoteDraftPayload;
    const ids = q.lines.map((l) => l.itemId).filter((x): x is string => !!x);
    const items = ids.length
      ? await tx<
          {
            id: string;
            unitCostPence: number;
            markupBp: number | null;
            sellPricePence: number | null;
          }[]
        >`
          SELECT id, unit_cost_pence, markup_bp, sell_price_pence FROM price_list_items WHERE id IN ${tx(ids)}`
      : [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const lines = q.lines.map((l) => {
      const i = l.itemId ? byId.get(l.itemId) : undefined;
      return quoteLineInput.parse({
        kind: l.kind,
        description: l.description,
        qtyMilli: l.qtyMilli,
        unitCostPence: i?.unitCostPence ?? null,
        markupBp: i?.markupBp ?? null,
        unitPricePence: l.unitPricePence ?? i?.sellPricePence ?? null,
      });
    });
    const e = await enquiries.convert(
      tx,
      auth,
      q.enquiryId,
      { to: 'quote', title: q.title },
      undefined,
      { lines, notes: q.notes || null },
    );
    result = { quoteId: e.quoteId, customerId: e.customerId };
  } else {
    const pu = p.payload as PriceUpdatePayload;
    const applied = await applyBill(tx, auth, pu.billId, false);
    result = {
      billId: pu.billId,
      priceChanges: applied.priceChanges.length,
      jobLines: applied.jobLines.length,
    };
  }
  await tx`
    UPDATE proposals SET status = 'applied', decided_by = ${auth.userId}, decided_at = now(), result = ${tx.json(result as never)}
     WHERE id = ${id}`;
  await event(tx, auth, id, 'approved');
  await event(tx, auth, id, 'applied', result);
  await audit(tx, auth, 'proposal_applied', 'proposal', id, { kind: p.kind });
  return getProposal(tx, id);
}

/** Within the two minutes: back to pending, nothing sent. */
export async function stop(tx: Tx, auth: Auth, id: string) {
  assertOwnerDecision(auth, 'stop an email');
  const p = await lock(tx, id);
  if (p.status !== 'held' || !p.holdUntil || p.holdUntil <= new Date())
    throw conflict(
      'too_late',
      'Too late to stop: the two minutes are up (or it was never approved).',
    );
  await tx`UPDATE proposals SET status = 'pending', hold_until = NULL, decided_by = NULL, decided_at = NULL WHERE id = ${id}`;
  await event(tx, auth, id, 'stopped');
  await audit(tx, auth, 'proposal_stopped', 'proposal', id, {});
  return getProposal(tx, id);
}
