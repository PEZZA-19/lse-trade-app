import {
  formatPence,
  formatQty,
  PROPOSAL_KIND_LABELS,
  type EmailPayload,
  type PriceUpdatePayload,
  type ProposalDto,
  type QuoteDraftPayload,
} from '@lse/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMe } from '../../api/hooks';
import { useDecide, useDraft, useProposal, useProposals } from '../../api/inbox';
import { IconSeal } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  Segmented,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { shortDate } from '../../lib/status';

const STATUS: Record<
  ProposalDto['status'],
  { label: string; tone: 'orange' | 'blue' | 'green' | 'grey' | 'red' }
> = {
  pending: { label: 'Waiting for you', tone: 'orange' },
  held: { label: 'Sending soon', tone: 'blue' },
  sent: { label: 'Sent', tone: 'green' },
  send_blocked: { label: 'Not sent', tone: 'red' },
  applied: { label: 'Done', tone: 'green' },
  discarded: { label: 'Discarded', tone: 'grey' },
};

function useSecondsLeft(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000)) : 0;
}

function Preview({ p }: { p: ProposalDto }) {
  if (p.kind === 'reply_email' || p.kind === 'overdue_reminder') {
    const m = p.payload as EmailPayload;
    return (
      <div className="email-preview" aria-label="Email preview">
        <div className="email-preview__head">
          <span>
            To: {m.toName} &lt;{m.to}&gt;
          </span>
          <strong>{m.subject}</strong>
        </div>
        <p className="message-block">{m.body}</p>
      </div>
    );
  }
  if (p.kind === 'quote_draft') {
    const q = p.payload as QuoteDraftPayload;
    return (
      <List className="form-list" label="Quote lines">
        <KeyValueRow label="Title" value={q.title} />
        {q.lines.map((l, i) => (
          <KeyValueRow
            key={i}
            label={`${formatQty(l.qtyMilli)} × ${l.description}`}
            value={
              l.kind === 'labour' ? 'Labour (hours)' : l.itemId ? 'Price list' : 'No price yet'
            }
          />
        ))}
        {q.notes && <KeyValueRow label="Notes" value={q.notes} />}
      </List>
    );
  }
  const u = p.payload as PriceUpdatePayload;
  return (
    <List className="form-list" label="Price changes">
      {u.changes.map((c, i) => (
        <KeyValueRow
          key={i}
          label={c.description}
          value={`${c.oldCostPence == null ? 'new' : formatPence(c.oldCostPence)} → ${formatPence(c.newCostPence)}`}
        />
      ))}
      <KeyValueRow label="Bill" value={<Link to={`/bills/${u.billId}`}>{u.billLabel}</Link>} />
    </List>
  );
}

/** One draft: what it will do, the draft itself, and the owner's three choices. */
function ProposalCard({ p, owner, detail }: { p: ProposalDto; owner: boolean; detail?: boolean }) {
  const decide = useDecide(p);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const left = useSecondsLeft(p.status === 'held' ? p.holdUntil : null);
  const isEmail = p.kind === 'reply_email' || p.kind === 'overdue_reminder';
  return (
    <Section
      header={
        detail ? PROPOSAL_KIND_LABELS[p.kind] : <Link to={`/approvals/${p.id}`}>{p.title}</Link>
      }
      aside={<Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>}
      footer={`${PROPOSAL_KIND_LABELS[p.kind]} · drafted ${p.drafter ? `by the AI helper (${p.drafter === 'fake' ? 'practice model, no real AI' : p.drafter})` : 'by a rule, no AI'} · ${shortDate(p.createdAt)}`}
    >
      <p className="will-do" role="note">
        <strong>Will do: </strong>
        {p.summary}
      </p>
      <Preview p={p} />
      {p.status === 'held' && (
        <div className="hold-bar" role="status">
          <span>
            Sending in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </span>
          {owner && (
            <Button
              variant="destructive"
              onClick={() =>
                decide.mutate(
                  { kind: 'stop' },
                  { onSuccess: () => toast.show('Stopped. Nothing was sent.') },
                )
              }
              loading={decide.isPending}
            >
              Stop
            </Button>
          )}
        </div>
      )}
      {p.status === 'send_blocked' && (
        <p className="field-error">{(p.result as { reason?: string })?.reason}</p>
      )}
      {p.status === 'pending' && owner && (
        <div className="decision-row" role="group" aria-label="Decide">
          <Button
            variant="primary"
            onClick={() =>
              decide.mutate(
                { kind: 'approve' },
                {
                  onSuccess: (r) =>
                    toast.show(
                      r.status === 'held' ? 'Approved: sending in 2 minutes' : 'Approved and done',
                    ),
                },
              )
            }
            loading={decide.isPending && decide.variables?.kind === 'approve'}
          >
            Approve
          </Button>
          {p.kind !== 'price_update' && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button
            variant="plain"
            onClick={() =>
              decide.mutate({ kind: 'discard' }, { onSuccess: () => toast.show('Discarded') })
            }
          >
            Discard
          </Button>
        </div>
      )}
      {p.status === 'pending' && !owner && (
        <p className="sheet-hint">Waiting for the owner to decide.</p>
      )}
      {decide.isError && (
        <p className="field-error" role="alert">
          {decide.error.message}
        </p>
      )}
      {editing && isEmail && (
        <EditEmailSheet
          p={p.payload as EmailPayload}
          busy={decide.isPending}
          onClose={() => setEditing(false)}
          onSave={(subject, body) =>
            decide.mutate(
              { kind: 'edit', patch: { subject, body } },
              {
                onSuccess: () => {
                  setEditing(false);
                  toast.show('Draft updated');
                },
              },
            )
          }
        />
      )}
      {editing && p.kind === 'quote_draft' && (
        <EditQuoteSheet
          q={p.payload as QuoteDraftPayload}
          busy={decide.isPending}
          onClose={() => setEditing(false)}
          onSave={(title, lines) =>
            decide.mutate(
              { kind: 'edit', patch: { title, lines } },
              {
                onSuccess: () => {
                  setEditing(false);
                  toast.show('Draft updated');
                },
              },
            )
          }
        />
      )}
    </Section>
  );
}

function EditEmailSheet(props: {
  p: EmailPayload;
  busy: boolean;
  onClose: () => void;
  onSave: (s: string, b: string) => void;
}) {
  const [subject, setSubject] = useState(props.p.subject);
  const [body, setBody] = useState(props.p.body);
  return (
    <Sheet
      open
      title="Edit Email"
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => props.onSave(subject, body)}
          loading={props.busy}
          disabled={!subject.trim() || !body.trim()}
          style={{ fontWeight: 600 }}
        >
          Save
        </Button>
      }
    >
      <Section footer="Your email signature is added by your email account, so there’s no sign-off here.">
        <List className="form-list">
          <TextField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <TextAreaField
            label="Message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            data-autofocus
          />
        </List>
      </Section>
    </Sheet>
  );
}

function EditQuoteSheet(props: {
  q: QuoteDraftPayload;
  busy: boolean;
  onClose: () => void;
  onSave: (t: string, l: QuoteDraftPayload['lines']) => void;
}) {
  const [title, setTitle] = useState(props.q.title);
  const [lines, setLines] = useState(props.q.lines);
  return (
    <Sheet
      open
      title="Edit Quote Draft"
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => props.onSave(title, lines)}
          loading={props.busy}
          disabled={!title.trim()}
          style={{ fontWeight: 600 }}
        >
          Save
        </Button>
      }
    >
      <Section>
        <List className="form-list">
          <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </List>
      </Section>
      <Section
        header="Lines"
        footer="Remove anything that doesn’t belong; prices come from the price list when the quote is made."
      >
        <List className="form-list">
          {lines.map((l, i) => (
            <li key={i} className="row">
              <span className="row__main">
                <span className="row__title">{l.description}</span>
                <span className="row__sub">
                  {formatQty(l.qtyMilli)} {l.kind === 'labour' ? 'hours' : ''}
                </span>
              </span>
              <Button
                variant="plain"
                onClick={() => setLines(lines.filter((_, n) => n !== i))}
                aria-label={`Remove ${l.description}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </List>
      </Section>
    </Sheet>
  );
}

/** Drafts from the AI helpers, waiting for the owner. Nothing here happens without a tap. */
export function ApprovalsScreen() {
  const [which, setWhich] = useState<'open' | 'done'>('open');
  const list = useProposals(which);
  const me = useMe();
  const owner = me.data?.role === 'owner';
  const draft = useDraft();
  const toast = useToast();
  const items = list.data ?? [];
  return (
    <Page title="Approvals" back={{ label: 'Home', to: '/home' }}>
      <Segmented
        label="Show"
        value={which}
        onChange={setWhich}
        options={[
          { value: 'open', label: 'Waiting' },
          { value: 'done', label: 'History' },
        ]}
      />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <EmptyState
          icon={<IconSeal />}
          title="Couldn’t load approvals"
          message={list.error.message}
          action={<Button onClick={() => list.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconSeal />}
          title={which === 'open' ? 'Nothing to approve' : 'No decisions yet'}
          message="AI helpers put drafts here: replies, payment reminders, quotes and price updates. Each needs your tap."
        />
      ) : (
        items.map((p) => <ProposalCard key={p.id} p={p} owner={owner} />)
      )}
      {which === 'open' && (
        <Section footer="Drafts a polite reminder for each overdue invoice with an email address. Nothing is sent until you approve each one.">
          <Button
            variant="secondary"
            block
            loading={draft.isPending}
            onClick={() =>
              draft.mutate('/proposals/overdue-reminders', {
                onSuccess: (r) => {
                  const res = r as { created: ProposalDto[]; skipped: string[] };
                  toast.show(
                    res.created.length
                      ? `${res.created.length} reminder ${res.created.length === 1 ? 'draft' : 'drafts'} added`
                      : res.skipped.length
                        ? `No drafts: ${res.skipped[0]}`
                        : 'No overdue invoices need a reminder',
                  );
                },
              })
            }
          >
            Draft Overdue Reminders
          </Button>
          {draft.isError && (
            <p className="field-error" role="alert">
              {draft.error.message}
            </p>
          )}
        </Section>
      )}
    </Page>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: 'Drafted',
  edited: 'Edited',
  approved: 'Approved',
  stopped: 'Stopped',
  sent: 'Sent',
  send_blocked: 'Not sent',
  applied: 'Done',
  discarded: 'Discarded',
};

/** One draft with its full log. */
export function ProposalScreen() {
  const { id = '' } = useParams();
  const q = useProposal(id);
  const me = useMe();
  if (q.isPending)
    return (
      <Page title="Approval" back={{ label: 'Approvals', to: '/approvals' }}>
        <ListSkeleton />
      </Page>
    );
  if (q.isError)
    return (
      <Page title="Approval" back={{ label: 'Approvals', to: '/approvals' }}>
        <EmptyState icon={<IconSeal />} title="Couldn’t load it" message={q.error.message} />
      </Page>
    );
  const p = q.data;
  return (
    <Page title={p.title} back={{ label: 'Approvals', to: '/approvals' }}>
      <ProposalCard p={p} owner={me.data?.role === 'owner'} detail />
      <Section header="Log">
        <List className="form-list" label="Log">
          {(p.events ?? []).map((e, i) => (
            <KeyValueRow
              key={i}
              label={`${EVENT_LABEL[e.event] ?? e.event}${e.byName ? ` by ${e.byName}` : e.event === 'created' ? ' by the helper' : ''}`}
              value={new Date(e.at).toLocaleString('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            />
          ))}
        </List>
      </Section>
    </Page>
  );
}
