import {
  BANK_CSV_MAX_BYTES,
  canSee,
  type BankImportResultDto,
  type BankTransactionDto,
} from '@lse/shared';
import { useRef, useState } from 'react';
import { useBankLineAction, useBankLines, useImportStatement } from '../../api/business';
import { useAccess } from '../../api/hooks';
import { IconBusiness } from '../../components/icons';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  List,
  ListSkeleton,
  Page,
  Section,
  Segmented,
} from '../../components/ui';
import { AddExpenseSheet } from './ExpensesScreen';
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
  const imp = useImportStatement();
  const act = useBankLineAction();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<BankImportResultDto | null>(null);
  const [expenseFor, setExpenseFor] = useState<BankTransactionDto | null>(null);
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
              />
            ))}
          </List>
        </Section>
      )}
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
}: {
  l: BankTransactionDto;
  canEdit: boolean;
  busy: boolean;
  onExpense: (l: BankTransactionDto) => void;
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
                ? 'No payment in the app matches. Record the payment on its invoice, then it’ll be suggested.'
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
