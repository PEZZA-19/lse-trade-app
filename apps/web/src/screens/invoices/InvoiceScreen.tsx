import {
  PAYMENT_METHOD_LABELS,
  creditBlocker,
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
import { IconDoc, IconPlusCircle, IconQuotes } from '../../components/icons';
import { DocumentSheet } from '../documents/DocumentSheet';
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
import { CreditNoteSheet, NewCreditNoteSheet } from './CreditNoteSheets';
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
  const [previewing, setPreviewing] = useState(false);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const st = INVOICE_STATUS[inv.displayStatus];
  const draft = inv.status === 'draft';
  /** A job that came to less than £0: a customer credit, used on their next invoice. */
  const isCredit = inv.status === 'credit' || (draft && inv.totalPence < 0);
  const docName = isCredit
    ? inv.number
      ? `Credit Note ${inv.number}`
      : 'Draft Credit Note'
    : inv.number
      ? `Invoice ${inv.number}`
      : 'Draft Invoice';
  const [crediting, setCrediting] = useState(false);
  const [creditId, setCreditId] = useState<string | null>(null);
  const [creditPreview, setCreditPreview] = useState<{
    id: string;
    title: string;
    draft: boolean;
  } | null>(null);
  const canCredit = !creditBlocker(inv);
  /** Something has come off: show what's still owed rather than the total. */
  const owing = !isCredit && inv.status !== 'paid' && inv.balancePence !== inv.totalPence && !draft;
  const lines = toInput(inv);
  const creditToUse = inv.creditToUsePence;
  // Asked every time there's credit to use; the default is what was chosen on the quote or job
  // (on if nothing was chosen), and the sheet says what it does.
  const [useCredit, setUseCredit] = useState(inv.jobUseCredit ?? true);

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
    decide.mutate(
      {
        action,
        ...(action === 'approve' && creditToUse > 0 ? { useCredit } : {}),
      },
      {
        onSuccess: (r) => {
          toast.show(
            action === 'approve'
              ? r.status === 'credit'
                ? `Issued · Credit note ${r.number}`
                : r.creditedPence > 0
                  ? `Approved · Invoice ${r.number} · ${formatPence(r.creditedPence)} credit used`
                  : `Approved · Invoice ${r.number}`
              : `Invoice ${r.number} marked as sent`,
          );
          setConfirm(null);
        },
      },
    );

  const visibleLines = inv.lines
    .map((l, i) => [l, i] as const)
    // Carriage at £0 isn't shown (spec).
    .filter(([l]) => !(l.kind === 'carriage' && l.totalPence === 0));

  return (
    <Page
      title={docName}
      subtitle={
        <>
          {inv.customerName} · <Link to={`/jobs/${inv.jobId}`}>Job {inv.jobNumber}</Link>
          {inv.quoteNumber ? ` · from ${inv.quoteNumber}` : ''}
        </>
      }
      back={{ label: 'Invoices', to: '/invoices' }}
    >
      <div className="hero">
        {isCredit ? (
          <>
            <div
              className="hero__amount"
              aria-label={`Credit ${formatPence(-inv.totalPence)}`}
              style={{ color: 'var(--green)' }}
            >
              {formatPence(-(draft ? inv.totalPence : inv.balancePence))}
            </div>
            <div className="hero__meta">
              <Pill tone={st.tone}>{st.label}</Pill>
              <span>
                {draft
                  ? 'comes to less than £0: issue it as a credit for the customer'
                  : inv.balancePence < 0
                    ? `credit left of ${formatPence(-inv.totalPence)} · comes off their next invoice`
                    : 'all used on later invoices'}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="hero__amount" aria-label={`Total ${formatPence(inv.totalPence)}`}>
              {formatPence(owing ? inv.balancePence : inv.totalPence)}
            </div>
            <div className="hero__meta">
              <Pill tone={st.tone}>{st.label}</Pill>
              <span>{owing ? `owed of ${formatPence(inv.totalPence)}` : dueLabel(inv)}</span>
            </div>
          </>
        )}
      </div>

      {/* The one next step, always an explicit owner tap. */}
      {inv.status !== 'paid' && inv.status !== 'credit' && (
        <Section
          footer={
            !isOwner
              ? 'Only the business owner can approve, send or record payments.'
              : draft
                ? inv.approvalBlockers.length
                  ? undefined
                  : isCredit
                    ? 'The customer isn’t refunded: the credit comes off their next invoice. Nothing is sent.'
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
              {isCredit ? 'Issue Customer Credit…' : 'Approve Invoice…'}
            </Button>
          )}
          {isOwner && inv.status === 'approved' && (
            <Button block large onClick={() => setConfirm('send')}>
              Mark as Sent…
            </Button>
          )}
          {isOwner && (inv.status === 'sent' || inv.status === 'part_paid') && (
            <Button block large onClick={() => setPaying(true)}>
              Record Payment
            </Button>
          )}
        </Section>
      )}

      <Section>
        <List>
          <li>
            <ButtonRow
              lead={<IconDoc width={22} height={22} color="var(--accent)" />}
              title="Preview PDF"
              sub={
                draft ? 'Draft preview: approve to share it' : `${docName} as the customer gets it`
              }
              onClick={() => setPreviewing(true)}
              chevron
            />
          </li>
        </List>
      </Section>
      <DocumentSheet
        open={previewing}
        onClose={() => setPreviewing(false)}
        kind="invoices"
        id={inv.id}
        title={docName}
        shareBlocked={
          draft
            ? 'This is a draft preview. Approve the invoice to give it its number and share it.'
            : null
        }
        afterShare={
          inv.status === 'approved' ? 'Sent it? Tap Mark as Sent to record it.' : undefined
        }
      />

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
              label={isCredit ? 'Credit to the customer' : 'Total'}
              value={formatPence(isCredit ? -inv.totalPence : inv.totalPence)}
              strong={inv.paidPence === 0 && !inv.creditUses.length}
            />
          </li>
          {inv.creditUses.map((u) => (
            <li key={u.id}>
              <Link className="row" to={`/invoices/${u.invoiceId}`}>
                <span className="row__main">
                  <span className="row__title">Used on invoice {u.invoiceNumber}</span>
                </span>
                <span className="row__meta num">−{formatPence(u.amountPence)}</span>
              </Link>
            </li>
          ))}
          {inv.creditUses.length > 0 && (
            <li>
              <KeyValueRow label="Credit left" value={formatPence(-inv.balancePence)} strong />
            </li>
          )}
          {inv.creditsApplied.map((u) => (
            <li key={u.id}>
              <Link className="row" to={`/invoices/${u.creditId}`}>
                <span className="row__main">
                  <span className="row__title">Customer credit {u.creditNumber} used</span>
                </span>
                <span className="row__meta num" style={{ color: 'var(--green)' }}>
                  −{formatPence(u.amountPence)}
                </span>
              </Link>
            </li>
          ))}
          {inv.paidPence > 0 && (
            <li>
              <KeyValueRow label="Paid" value={`−${formatPence(inv.paidPence)}`} />
            </li>
          )}
          {inv.creditNotes
            .filter((c) => c.status === 'approved')
            .map((c) => (
              <li key={c.id}>
                <KeyValueRow
                  label={`Credit note ${c.number}`}
                  value={`−${formatPence(c.amountPence)}`}
                />
              </li>
            ))}
          {(inv.paidPence > 0 || inv.creditedPence > 0) && (
            <>
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

      {(inv.creditNotes.length > 0 || canCredit) && (
        <Section
          header="Credit notes"
          footer={
            canCredit
              ? 'Take money off this invoice for a mistake, goodwill or work not done. The owner approves it.'
              : undefined
          }
        >
          <List label="Credit notes">
            {inv.creditNotes.map((c) => (
              <li key={c.id}>
                <ButtonRow
                  title={c.number ? `Credit note ${c.number}` : 'Draft credit note'}
                  sub={
                    <>
                      {c.status === 'draft' ? (
                        <Pill tone="orange">Draft</Pill>
                      ) : (
                        <Pill tone="green">Approved</Pill>
                      )}{' '}
                      {c.reason}
                    </>
                  }
                  meta={<span className="num">−{formatPence(c.amountPence)}</span>}
                  onClick={() => setCreditId(c.id)}
                  chevron
                />
              </li>
            ))}
            {canCredit && (
              <li>
                <ButtonRow
                  onClick={() => setCrediting(true)}
                  lead={<IconPlusCircle width={22} height={22} color="var(--accent)" />}
                  title={<span style={{ color: 'var(--accent)' }}>New credit note…</span>}
                />
              </li>
            )}
          </List>
        </Section>
      )}
      <NewCreditNoteSheet
        open={crediting}
        invoice={inv}
        onClose={() => setCrediting(false)}
        onCreated={(cid) => setCreditId(cid)}
      />
      <CreditNoteSheet
        id={creditId}
        isOwner={isOwner}
        onClose={() => setCreditId(null)}
        onPreview={(cid, title, isDraft) => {
          setCreditId(null);
          setCreditPreview({ id: cid, title, draft: isDraft });
        }}
      />
      <DocumentSheet
        open={!!creditPreview}
        onClose={() => setCreditPreview(null)}
        kind="credit-notes"
        id={creditPreview?.id ?? ''}
        title={creditPreview?.title ?? 'Credit Note'}
        shareBlocked={
          creditPreview?.draft
            ? 'This is a draft preview. Approve the credit note to give it its number and share it.'
            : null
        }
      />

      <Section
        header="Details"
        footer={
          isCredit
            ? 'A customer credit comes off this customer’s next invoice. It isn’t paid out.'
            : inv.termsText
        }
      >
        <List>
          {inv.issueDate && (
            <li>
              <KeyValueRow
                label={isCredit ? 'Credit date' : 'Invoice date'}
                value={shortDate(`${inv.issueDate}T12:00:00Z`)}
              />
            </li>
          )}
          {!isCredit && (
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
          )}
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
        open={confirm === 'approve' && isCredit}
        title="Issue Customer Credit"
        actionLabel="Issue Credit"
        onConfirm={() => run('approve')}
        onClose={closeConfirm}
        loading={decide.isPending}
        error={decide.error?.message}
      >
        <p>
          <strong>{formatPence(-inv.totalPence)}</strong> credit for {inv.customerName}.
        </p>
        <ul>
          <li>
            It becomes credit note <strong>{inv.nextNumber ?? 'CN'}</strong> and is locked.
          </li>
          <li>
            When you approve their next invoice, you’ll be asked whether to use it. No money is paid
            out.
          </li>
          <li>Nothing is sent to the customer.</li>
        </ul>
      </ConfirmSheet>
      <ConfirmSheet
        open={confirm === 'approve' && !isCredit}
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
          {creditToUse > 0 && useCredit && (
            <li>
              <strong>{formatPence(creditToUse)}</strong> of their customer credit comes off it, so
              they owe <strong>{formatPence(inv.totalPence - creditToUse)}</strong>.
            </li>
          )}
          {creditToUse > 0 && !useCredit && (
            <li>Their customer credit stays on their account for a later invoice.</li>
          )}
          <li>Nothing is sent to the customer.</li>
        </ul>
        {creditToUse > 0 && (
          <List className="form-list" label="Customer credit">
            <li>
              <label className="row" style={{ cursor: 'pointer' }}>
                <span className="row__main">
                  <span className="row__title">Use their credit</span>
                  <span className="row__sub" style={{ whiteSpace: 'normal' }}>
                    {formatPence(creditToUse)} available on account
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Use their credit on this invoice"
                  checked={useCredit}
                  onChange={(e) => setUseCredit(e.target.checked)}
                  className="switch"
                />
              </label>
            </li>
          </List>
        )}
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
