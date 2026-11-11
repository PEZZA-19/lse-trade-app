import {
  PAYMENT_METHOD_LABELS,
  formatPence,
  formatQty,
  type InvoiceDetailDto,
  type InvoiceLineInput,
} from '@lse/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  useDeleteInvoice,
  useInvoice,
  useInvoiceDecision,
  useUpdateInvoice,
} from '../../api/billing';
import { useSession } from '../../api/hooks';
import { IconPlusCircle, IconQuotes } from '../../components/icons';
import { useToast } from '../../components/Toast';
import {
  Button,
  ButtonRow,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
} from '../../components/ui';
import { formatDayShort, formatTime } from '../../lib/dates';
import { INVOICE_STATUS, dueLabel, shortDate } from '../../lib/status';
import { ConfirmSheet, InvoiceLineSheet, PaymentSheet } from './InvoiceSheets';

export function InvoiceScreen() {
  const { id = '' } = useParams();
  const inv = useInvoice(id);
  if (inv.isPending)
    return (
      <Page title="Invoice" back={{ label: 'Invoices', to: '/invoices' }}>
        <ListSkeleton />
      </Page>
    );
  if (inv.isError)
    return (
      <Page title="Invoice" back={{ label: 'Invoices', to: '/invoices' }}>
        <EmptyState
          icon={<IconQuotes />}
          title="Couldn’t load this invoice"
          message={inv.error.message}
          action={<Button onClick={() => inv.refetch()}>Try again</Button>}
        />
      </Page>
    );
  return <InvoiceView key={inv.data.id} inv={inv.data} />;
}

const when = (iso: string) => `${formatDayShort(new Date(iso))}, ${formatTime(iso)}`;
const toInput = (inv: InvoiceDetailDto): InvoiceLineInput[] =>
  inv.lines.map((l) => ({
    kind: l.kind,
    description: l.description,
    qtyMilli: l.qtyMilli,
    unitPricePence: l.unitPricePence,
    taxRateBp: l.taxRateBp,
  }));

function InvoiceView({ inv }: { inv: InvoiceDetailDto }) {
  const session = useSession();
  const isOwner = session.data?.role === 'owner';
  const toast = useToast();
  const navigate = useNavigate();
  const decide = useInvoiceDecision(inv);
  const update = useUpdateInvoice(inv);
  const del = useDeleteInvoice(inv);
  const [confirm, setConfirm] = useState<'approve' | 'send' | 'delete' | null>(null);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const st = INVOICE_STATUS[inv.displayStatus];
  const draft = inv.status === 'draft';
  const lines = toInput(inv);

  const saveLines = (next: InvoiceLineInput[]) =>
    update.mutate(
      { lines: next },
      { onError: (e) => toast.show(`Not saved. ${e.message}`, { tone: 'error' }) },
    );
  const closeConfirm = () => {
    decide.reset();
    setConfirm(null);
  };
  const run = (action: 'approve' | 'mark-sent') =>
    decide.mutate(action, {
      onSuccess: (r) => {
        toast.show(
          action === 'approve'
            ? `Approved · Invoice ${r.number}`
            : `Invoice ${r.number} marked as sent`,
        );
        setConfirm(null);
      },
    });

  const visibleLines = inv.lines
    .map((l, i) => [l, i] as const)
    // Carriage at £0 isn't shown (spec).
    .filter(([l]) => !(l.kind === 'carriage' && l.totalPence === 0));

  return (
    <Page
      title={inv.number ? `Invoice ${inv.number}` : 'Draft Invoice'}
      subtitle={
        <>
          {inv.customerName} · <Link to={`/jobs/${inv.jobId}`}>Job {inv.jobNumber}</Link>
          {inv.quoteNumber ? ` · from ${inv.quoteNumber}` : ''}
        </>
      }
      back={{ label: 'Invoices', to: '/invoices' }}
    >
      <div className="hero">
        <div className="hero__amount" aria-label={`Total ${formatPence(inv.totalPence)}`}>
          {formatPence(inv.status === 'part_paid' ? inv.balancePence : inv.totalPence)}
        </div>
        <div className="hero__meta">
          <Pill tone={st.tone}>{st.label}</Pill>
          <span>
            {inv.status === 'part_paid' ? `owed of ${formatPence(inv.totalPence)}` : dueLabel(inv)}
          </span>
        </div>
      </div>

      {/* The one next step, always an explicit owner tap. */}
      {inv.status !== 'paid' && (
        <Section
          footer={
            !isOwner
              ? 'Only the business owner can approve, send or record payments.'
              : draft
                ? inv.approvalBlockers.length
                  ? undefined
                  : 'Approving gives it its number and locks it. Nothing is sent.'
                : inv.status === 'approved'
                  ? 'This records that you’ve sent it. The app doesn’t email invoices yet.'
                  : 'Record money as it arrives, in full or in part.'
          }
        >
          {draft && inv.approvalBlockers.length > 0 && (
            <Blockers blockers={inv.approvalBlockers} customerHint={inv.customerName} />
          )}
          {isOwner && draft && (
            <Button
              block
              large
              disabled={inv.approvalBlockers.length > 0}
              onClick={() => setConfirm('approve')}
            >
              Approve Invoice…
            </Button>
          )}
          {isOwner && inv.status === 'approved' && (
            <Button block large onClick={() => setConfirm('send')}>
              Mark as Sent…
            </Button>
          )}
          {isOwner && (inv.status === 'sent' || inv.status === 'part_paid') && (
            <Button block large onClick={() => setPaying(true)}>
              Record Payment…
            </Button>
          )}
        </Section>
      )}

      <Section header="Bill to">
        <List>
          <li>
            <div className="row">
              <span className="row__main">
                <span className="row__title">{inv.billTo.name}</span>
                <span className="row__sub">
                  {inv.billTo.email ?? <span style={{ color: 'var(--red)' }}>No email</span>}
                  {inv.billTo.address ? ` · ${inv.billTo.address}` : ''}
                </span>
              </span>
            </div>
          </li>
        </List>
      </Section>

      <Section
        header="Lines"
        footer={draft ? 'Tap a line to change it. Lines lock once approved.' : undefined}
      >
        <List label="Invoice lines">
          {visibleLines.map(([l, i]) => {
            const row = (
              <>
                <span className="row__main">
                  <span className="row__title">{l.description}</span>
                  {l.qtyMilli !== 1000 && (
                    <span className="row__sub">
                      {formatQty(l.qtyMilli)}
                      {l.kind === 'labour' ? ' h' : ''} × {formatPence(l.unitPricePence)}
                    </span>
                  )}
                </span>
                <span
                  className="row__meta num"
                  style={{ color: l.totalPence < 0 ? 'var(--green)' : 'var(--label)' }}
                >
                  {formatPence(l.totalPence)}
                </span>
              </>
            );
            return (
              <li key={l.id}>
                {draft ? (
                  <button type="button" className="row" onClick={() => setEditing(i)}>
                    {row}
                  </button>
                ) : (
                  <div className="row">{row}</div>
                )}
              </li>
            );
          })}
          {draft && (
            <li>
              <ButtonRow
                onClick={() => setEditing('new')}
                lead={<IconPlusCircle width={22} height={22} color="var(--accent)" />}
                title={<span style={{ color: 'var(--accent)' }}>Add line</span>}
              />
            </li>
          )}
        </List>
      </Section>

      <Section header="Totals">
        <List>
          {inv.taxPence !== 0 && (
            <>
              <li>
                <KeyValueRow label="Subtotal" value={formatPence(inv.subtotalPence)} />
              </li>
              <li>
                <KeyValueRow label="Tax" value={formatPence(inv.taxPence)} />
              </li>
            </>
          )}
          <li>
            <KeyValueRow
              label="Total"
              value={formatPence(inv.totalPence)}
              strong={inv.paidPence === 0}
            />
          </li>
          {inv.paidPence > 0 && (
            <>
              <li>
                <KeyValueRow label="Paid" value={`−${formatPence(inv.paidPence)}`} />
              </li>
              <li>
                <KeyValueRow label="Balance due" value={formatPence(inv.balancePence)} strong />
              </li>
            </>
          )}
        </List>
      </Section>

      {inv.payments.length > 0 && (
        <Section header="Payments">
          <List label="Payments">
            {inv.payments.map((p) => (
              <li key={p.id}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">{PAYMENT_METHOD_LABELS[p.method]}</span>
                    <span className="row__sub">
                      {shortDate(`${p.paidOn}T12:00:00Z`)}
                      {p.reference ? ` · ${p.reference}` : ''} · recorded by {p.recordedByName}
                    </span>
                  </span>
                  <span className="row__meta num" style={{ color: 'var(--label)' }}>
                    {formatPence(p.amountPence)}
                  </span>
                </div>
              </li>
            ))}
          </List>
        </Section>
      )}

      <Section header="Details" footer={inv.termsText}>
        <List>
          {inv.issueDate && (
            <li>
              <KeyValueRow label="Invoice date" value={shortDate(`${inv.issueDate}T12:00:00Z`)} />
            </li>
          )}
          <li>
            <KeyValueRow
              label="Due"
              value={
                inv.dueDate
                  ? shortDate(`${inv.dueDate}T12:00:00Z`)
                  : `${inv.termsDays} days after approval`
              }
            />
          </li>
          {inv.approvedAt && (
            <li>
              <KeyValueRow
                label="Approved"
                value={`${inv.approvedByName} · ${when(inv.approvedAt)}`}
              />
            </li>
          )}
          {inv.sentAt && (
            <li>
              <KeyValueRow label="Marked sent" value={`${inv.sentByName} · ${when(inv.sentAt)}`} />
            </li>
          )}
        </List>
      </Section>

      {draft && (
        <Button variant="destructive" block onClick={() => setConfirm('delete')}>
          Delete Draft
        </Button>
      )}

      <ConfirmSheet
        open={confirm === 'approve'}
        title="Approve Invoice"
        actionLabel="Approve"
        onConfirm={() => run('approve')}
        onClose={closeConfirm}
        loading={decide.isPending}
        error={decide.error?.message}
      >
        <p>
          <strong>{formatPence(inv.totalPence)}</strong> to {inv.billTo.name}
          {inv.billTo.email ? ` (${inv.billTo.email})` : ''}.
        </p>
        <ul>
          <li>
            It becomes invoice <strong>{inv.nextNumber ?? inv.jobNumber}</strong> and is locked.
          </li>
          <li>Due {inv.termsDays} days from today.</li>
          <li>Nothing is sent to the customer.</li>
        </ul>
      </ConfirmSheet>
      <ConfirmSheet
        open={confirm === 'send'}
        title="Mark as Sent"
        actionLabel="Mark as Sent"
        onConfirm={() => run('mark-sent')}
        onClose={closeConfirm}
        loading={decide.isPending}
        error={decide.error?.message}
      >
        <p>
          Record that invoice <strong>{inv.number}</strong> has gone to{' '}
          {inv.billTo.email ?? inv.billTo.name}?
        </p>
        <ul>
          <li>The app doesn’t email it: send the PDF yourself for now.</li>
          <li>
            The due date counts from the invoice date (
            {inv.dueDate ? shortDate(`${inv.dueDate}T12:00:00Z`) : '—'}).
          </li>
        </ul>
      </ConfirmSheet>
      <ConfirmSheet
        open={confirm === 'delete'}
        title="Delete Draft"
        actionLabel="Delete"
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              toast.show('Draft deleted');
              navigate(`/jobs/${inv.jobId}`, { replace: true });
            },
          })
        }
        onClose={() => setConfirm(null)}
        loading={del.isPending}
        error={del.error?.message}
      >
        <p>Delete this draft? Any time it included goes back to unbilled. No number is used.</p>
      </ConfirmSheet>
      {isOwner && paying && <PaymentSheet open invoice={inv} onClose={() => setPaying(false)} />}
      {editing !== null && (
        <InvoiceLineSheet
          open
          line={editing === 'new' ? null : (lines[editing] ?? null)}
          onClose={() => setEditing(null)}
          onSave={(l) =>
            saveLines(
              editing === 'new' ? [...lines, l] : lines.map((x, i) => (i === editing ? l : x)),
            )
          }
          {...(editing !== 'new' && lines.length > 1
            ? { onDelete: () => saveLines(lines.filter((_, i) => i !== editing)) }
            : {})}
        />
      )}
    </Page>
  );
}

/** Why Approve is greyed out, with a way to fix each. */
function Blockers({ blockers, customerHint }: { blockers: string[]; customerHint: string }) {
  const settings = blockers.filter((b) => b !== 'Bill payer email' && b !== 'An amount to invoice');
  return (
    <p className="send-blocked" role="note">
      Before approving:{' '}
      {settings.length > 0 && (
        <>
          add your {settings.map((b) => b.toLowerCase()).join(', ')} in{' '}
          <Link to="/settings">Settings</Link>
          {blockers.length > settings.length ? '; ' : '.'}
        </>
      )}
      {blockers.includes('Bill payer email') && (
        <>
          add an email for {customerHint}’s bill payer in <Link to="/customers">Customers</Link>
          {blockers.includes('An amount to invoice') ? '; ' : '.'}
        </>
      )}
      {blockers.includes('An amount to invoice') && <>the total must be more than £0.</>}
    </p>
  );
}
