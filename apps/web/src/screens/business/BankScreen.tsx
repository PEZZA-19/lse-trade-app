import {
  BANK_CSV_MAX_BYTES,
  reconcileBank,
  canSee,
  type BankImportResultDto,
  type BankTransactionDto,
} from '@lse/shared';
import { useRef, useState } from 'react';
import {
  useBankLineAction,
  useBankLines,
  useBusiness,
  useImportStatement,
  usePaymentFromBankLine,
} from '../../api/business';
import { useAccess } from '../../api/hooks';
import { IconBusiness } from '../../components/icons';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  Section,
  Segmented,
} from '../../components/ui';
import { AddExpenseSheet } from './ExpensesScreen';
import { useSession } from '../../api/hooks';
import { useInvoices } from '../../api/billing';
import { Sheet } from '../../components/Sheet';
import { money, shortDate } from './format';

type Tab = 'unmatched' | 'matched' | 'ignored';

/**
 * Business › Bank Statement: import the CSV your bank lets you download, then match each line to
 * what the app recorded (customer payments, supplier payments, expenses). Matching checks the app
 * against the bank; it never changes the books.
 */
export function BankScreen() {
  const canEdit = canSee(useAccess(), 'financials');
  const [tab, setTab] = useState<Tab>('unmatched');
  const lines = useBankLines(tab);
  const everything = useBankLines('all');
  const books = useBusiness();
  const rec = everything.data && books.data ? reconcileBank(everything.data, books.data) : null;
  const toMatch = everything.data?.filter((l) => l.status === 'unmatched').length ?? 0;
  const imp = useImportStatement();
  const act = useBankLineAction();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<BankImportResultDto | null>(null);
  const [expenseFor, setExpenseFor] = useState<BankTransactionDto | null>(null);
  const [paymentFor, setPaymentFor] = useState<BankTransactionDto | null>(null);
  const isOwner = useSession().data?.role === 'owner';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(
    new Date(),
  );
  const back = { label: 'Business', to: '/business' };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > BANK_CSV_MAX_BYTES) {
      toast.show('That file is too big for a bank statement (2 MB at most).', { tone: 'error' });
      return;
    }
    const csv = await f.text();
    imp.mutate(
      { fileName: f.name, csv },
      {
        onSuccess: (r) => {
          setResult(r);
          setTab('unmatched');
          toast.show(
            r.added
              ? `${r.added} bank ${r.added === 1 ? 'line' : 'lines'} imported`
              : 'Nothing new: these lines were already imported',
          );
        },
        onError: (e) => toast.show(e.message, { tone: 'error' }),
      },
    );
    if (file.current) file.current.value = '';
  };

  const run = (a: Parameters<typeof act.mutate>[0], done: string) =>
    act.mutate(a, {
      onSuccess: () => toast.show(done),
      onError: (e) => toast.show(e.message, { tone: 'error' }),
    });

  return (
    <Page title="Bank Statement" back={back}>
      {canEdit && (
        <div className="action-bar">
          <input
            ref={file}
            type="file"
            accept=".csv,text/csv"
            aria-label="Bank statement CSV file"
            style={{ display: 'none' }}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button large block loading={imp.isPending} onClick={() => file.current?.click()}>
            Import Bank Statement (CSV)
          </Button>
        </div>
      )}
      {result && (
        <Section
          header="Last import"
          footer={result.columns ? `Read as: ${result.columns}.` : undefined}
        >
          <List label="Last import">
            <li>
              <div className="row">
                <span className="row__main">
                  <span className="row__title">
                    {result.added} new · {result.alreadyImported} already imported
                  </span>
                  {result.from && (
                    <span className="row__sub">
                      {shortDate(result.from)} to {shortDate(result.to!)}
                    </span>
                  )}
                </span>
              </div>
            </li>
            {result.problems.slice(0, 5).map((p) => (
              <li key={`${p.line}-${p.message}`}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title" style={{ color: 'var(--orange, var(--red))' }}>
                      {p.line ? `Line ${p.line} skipped` : 'Not read'}
                    </span>
                    <span className="row__sub" style={{ whiteSpace: 'normal' }}>
                      {p.message}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </List>
        </Section>
      )}
      {rec && (
        <Section
          header="Check against your bank"
          footer={
            rec.differencePence === 0
              ? 'The app’s Bank and Cash matches your bank on that day.'
              : `They differ${toMatch ? ` and ${toMatch} bank ${toMatch === 1 ? 'line is' : 'lines are'} still to match` : ''}. Usually it’s money in or out not yet recorded in the app, or the opening balance (Business › Bank and Cash).`
          }
        >
          <List label="Bank check">
            <li>
              <KeyValueRow
                label={`Your bank on ${shortDate(rec.date)}`}
                value={money(rec.bankPence)}
              />
            </li>
            <li>
              <KeyValueRow label="The app’s Bank and Cash" value={money(rec.appPence)} />
            </li>
            <li>
              <KeyValueRow
                label="Difference"
                value={rec.differencePence === 0 ? 'None ✓' : money(rec.differencePence)}
                strong
              />
            </li>
          </List>
        </Section>
      )}
      <div style={{ padding: '0 16px 8px' }}>
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'unmatched', label: 'To Match' },
            { value: 'matched', label: 'Matched' },
            { value: 'ignored', label: 'Ignored' },
          ]}
        />
      </div>
      {lines.isError ? (
        <EmptyState
          icon={<IconBusiness />}
          title="Couldn’t load the bank lines"
          message={lines.error.message}
          action={<Button onClick={() => lines.refetch()}>Try again</Button>}
        />
      ) : !lines.data ? (
        <ListSkeleton rows={5} />
      ) : lines.data.length === 0 ? (
        <p className="section__footer">
          {tab === 'unmatched'
            ? 'Nothing to match. Download a CSV statement from your online banking and import it here.'
            : tab === 'matched'
              ? 'Nothing matched yet.'
              : 'Nothing ignored.'}
        </p>
      ) : (
        <Section
          footer={
            tab === 'unmatched'
              ? 'Suggestions have the same amount within 10 days. Ignore lines the app doesn’t need, like transfers between your own accounts. Matching never changes your books.'
              : undefined
          }
        >
          <List label="Bank lines">
            {lines.data.map((l) => (
              <BankLine
                key={l.id}
                l={l}
                canEdit={canEdit}
                busy={act.isPending}
                run={run}
                onExpense={setExpenseFor}
                onPayment={isOwner ? setPaymentFor : undefined}
              />
            ))}
          </List>
        </Section>
      )}
      {paymentFor && <PaymentFromBankSheet line={paymentFor} onClose={() => setPaymentFor(null)} />}
      {expenseFor && (
        <AddExpenseSheet today={today} fromBank={expenseFor} onClose={() => setExpenseFor(null)} />
      )}
    </Page>
  );
}

function BankLine({
  l,
  canEdit,
  busy,
  run,
  onExpense,
  onPayment,
}: {
  l: BankTransactionDto;
  canEdit: boolean;
  busy: boolean;
  onExpense: (l: BankTransactionDto) => void;
  /** Owner only: recording a payment is the owner's decision. */
  onPayment?: (l: BankTransactionDto) => void;
  run: (a: Parameters<ReturnType<typeof useBankLineAction>['mutate']>[0], done: string) => void;
}) {
  const inn = l.amountPence > 0;
  return (
    <li>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="row__main">
          <span className="row__title">{l.description}</span>
          <span className="row__sub">
            {shortDate(l.date)}
            {l.reference ? ` · ${l.reference}` : ''}
            {l.matchedTo ? ` · ${l.matchedTo.label}` : ''}
          </span>
          {canEdit && l.status === 'unmatched' && l.suggestions.length > 0 && (
            <span style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              {l.suggestions.map((s) => (
                <span
                  key={`${s.kind}:${s.id}`}
                  style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block' }}>{s.label}</span>
                    <span className="row__sub" style={{ whiteSpace: 'normal' }}>
                      {s.strong ? 'Likely · ' : ''}
                      {s.reason}
                    </span>
                  </span>
                  <Button
                    variant={s.strong ? 'primary' : 'secondary'}
                    disabled={busy}
                    aria-label={`Match ${l.description} to ${s.label}`}
                    onClick={() => run({ id: l.id, match: { kind: s.kind, id: s.id } }, 'Matched')}
                  >
                    Match
                  </Button>
                </span>
              ))}
            </span>
          )}
          {canEdit && l.status === 'unmatched' && l.suggestions.length === 0 && (
            <span className="row__sub" style={{ whiteSpace: 'normal' }}>
              {inn
                ? onPayment
                  ? 'No payment in the app matches. Tap Record Payment to pick the invoice it pays.'
                  : 'No payment in the app matches. Ask the owner to record it on its invoice, then it’ll be suggested.'
                : 'Nothing in the app matches. Add it as an expense, or record the supplier bill payment, then it’ll be suggested.'}
            </span>
          )}
        </span>
        <span className="row__meta" style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
          <span className="num" style={{ color: inn ? 'var(--green)' : 'var(--label)' }}>
            {inn ? '+' : '−'}
            {money(Math.abs(l.amountPence))}
          </span>
          {canEdit && l.status === 'unmatched' && !inn && (
            <Button
              variant="plain"
              disabled={busy}
              aria-label={`Add ${l.description} as an expense`}
              onClick={() => onExpense(l)}
            >
              Add as Expense
            </Button>
          )}
          {canEdit && l.status === 'unmatched' && inn && onPayment && (
            <Button
              variant="plain"
              disabled={busy}
              aria-label={`Record ${l.description} as a customer payment`}
              onClick={() => onPayment(l)}
            >
              Record Payment
            </Button>
          )}
          {canEdit && l.status === 'unmatched' && (
            <Button
              variant="plain"
              disabled={busy}
              aria-label={`Ignore ${l.description}`}
              onClick={() => run({ id: l.id, status: 'ignored' }, 'Ignored')}
            >
              Ignore
            </Button>
          )}
          {canEdit && l.status !== 'unmatched' && (
            <Button
              variant="plain"
              disabled={busy}
              aria-label={`${l.status === 'matched' ? 'Unmatch' : 'Restore'} ${l.description}`}
              onClick={() =>
                run(
                  { id: l.id, status: 'unmatched' },
                  l.status === 'matched' ? 'Unmatched' : 'Back in To Match',
                )
              }
            >
              {l.status === 'matched' ? 'Unmatch' : 'Restore'}
            </Button>
          )}
        </span>
      </div>
    </li>
  );
}

/** Pick the sent invoice this money-in line pays; exact balances first, then any it fits. */
function PaymentFromBankSheet({
  line,
  onClose,
}: {
  line: BankTransactionDto;
  onClose: () => void;
}) {
  const invoices = useInvoices('outstanding');
  const pay = usePaymentFromBankLine();
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const open = (invoices.data ?? [])
    .filter((i) => (i.status === 'sent' || i.status === 'part_paid') && i.balancePence > 0)
    .map((i) => ({ ...i, exact: i.balancePence === line.amountPence }))
    .sort(
      (a, b) => Number(b.exact) - Number(a.exact) || (a.number ?? '').localeCompare(b.number ?? ''),
    );
  const fits = open.filter((i) => i.balancePence >= line.amountPence);
  const chosen = fits.find((i) => i.id === picked);
  const save = () =>
    chosen &&
    pay.mutate(
      { id: line.id, invoiceId: chosen.id },
      {
        onSuccess: (r) => {
          toast.show(
            r.jobCompleted
              ? `Payment recorded on ${chosen.number}. Paid in full, so the job is complete.`
              : `Payment recorded on ${chosen.number} and matched.`,
          );
          onClose();
        },
        onError: (e) => toast.show(e.message, { tone: 'error' }),
      },
    );
  return (
    <Sheet
      open
      title="Record Payment"
      onClose={onClose}
      action={
        <Button onClick={save} disabled={!chosen || pay.isPending}>
          Record
        </Button>
      }
    >
      <p className="section__footer" style={{ marginTop: 0 }}>
        {money(line.amountPence)} in on {shortDate(line.date)} · {line.description}. It’s recorded
        as a bank transfer on that day and matched to this line.
      </p>
      {!invoices.data ? (
        <ListSkeleton rows={3} />
      ) : fits.length === 0 ? (
        <p className="section__footer">
          No sent invoice has {money(line.amountPence)} or more still owed. Send the invoice first,
          or if it’s a refund or transfer, Ignore the line.
        </p>
      ) : (
        <Section header="Which invoice does it pay?">
          <List label="Invoices to pay">
            {fits.map((i) => (
              <li key={i.id}>
                <label className="row" style={{ cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="bank-pay-invoice"
                    checked={picked === i.id}
                    onChange={() => setPicked(i.id)}
                    aria-label={`${i.number} ${i.customerName}`}
                  />
                  <span className="row__main">
                    <span className="row__title">
                      {i.number} · {i.customerName}
                    </span>
                    <span className="row__sub">
                      {i.jobTitle}
                      {i.exact ? ' · Same amount' : ' · Part payment'}
                    </span>
                  </span>
                  <span className="row__meta num">{money(i.balancePence)} owed</span>
                </label>
              </li>
            ))}
          </List>
        </Section>
      )}
    </Sheet>
  );
}
