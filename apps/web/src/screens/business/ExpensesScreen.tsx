import {
  accountByCode,
  EXPENSE_ACCOUNT_CODES,
  expenseTotals,
  parsePounds,
  presetRange,
  WAGES_ACCOUNT,
  type ExpenseAccountCode,
  type BankTransactionDto,
  type ExpenseDto,
} from '@lse/shared';
import { useMemo, useState } from 'react';
import {
  useBusiness,
  useAddExpense,
  useDeleteExpense,
  useExpenseFromBankLine,
  useExpenses,
} from '../../api/business';
import { useAccess, useMembers } from '../../api/hooks';
import { canSee } from '@lse/shared';
import { IconBusiness } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  Section,
  SelectField,
  TextField,
} from '../../components/ui';
import { ConfirmSheet } from '../invoices/InvoiceSheets';
import { money, shortDate } from './format';

const name = (code: string) => accountByCode(code)?.name ?? code;
/** "CONDOR FERRIES LTD" → "Condor Ferries Ltd" (bank lines are often in capitals). */
const titleCase = (s: string) =>
  s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) : s;

/**
 * Business › Expenses and Wages: overheads that aren't supplier bills (insurance, fuel, phone,
 * ferries, software) and wages, so the Profit and Loss shows a real net profit. Everyone with
 * Accounts access can see, add and remove them.
 */
export function ExpensesScreen() {
  // Anyone with Accounts access can add and remove them (Joe, 18 Nov 2026); the API enforces it.
  const canEdit = canSee(useAccess(), 'financials');
  const list = useExpenses();
  const b = useBusiness();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ExpenseDto | null>(null);
  const del = useDeleteExpense();
  const toast = useToast();
  const today = b.data?.today ?? new Date().toISOString().slice(0, 10);
  const yearStart = b.data?.yearStart ?? '01-01';
  const ytd = useMemo(() => presetRange('year_to_date', today, yearStart), [today, yearStart]);
  const totals = useMemo(() => expenseTotals(list.data ?? [], ytd), [list.data, ytd]);
  const total = totals.reduce((s, t) => s + t.netPence, 0);
  const back = { label: 'Business', to: '/business' };

  if (list.isError)
    return (
      <Page title="Expenses" back={back}>
        <EmptyState
          icon={<IconBusiness />}
          title="Couldn’t load expenses"
          message={list.error.message}
          action={<Button onClick={() => list.refetch()}>Try again</Button>}
        />
      </Page>
    );
  if (!list.data)
    return (
      <Page title="Expenses" back={back}>
        <ListSkeleton rows={6} />
      </Page>
    );
  return (
    <Page title="Expenses and Wages" back={back}>
      {canEdit && (
        <div className="action-bar">
          <Button large block onClick={() => setAdding(true)}>
            Add Expense or Wages
          </Button>
        </div>
      )}
      <Section
        header={`This year so far (from ${shortDate(ytd.from)})`}
        footer="Before tax you can reclaim. These come off gross profit in the Profit and Loss."
      >
        <List label="Expenses by account">
          {totals.map((t) => (
            <li key={t.account}>
              <KeyValueRow label={t.name} value={money(t.netPence)} />
            </li>
          ))}
          <li>
            <KeyValueRow label="Total" value={money(total)} strong />
          </li>
        </List>
      </Section>
      <Section header="Recent">
        {list.data.length === 0 ? (
          <p className="section__footer" style={{ marginTop: 0 }}>
            Nothing yet. Add fuel, insurance, phone, ferries, software and wages here as you pay
            them.
          </p>
        ) : (
          <List label="Expenses">
            {list.data.slice(0, 100).map((e) => (
              <li key={e.id}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">{e.payee}</span>
                    <span className="row__sub">
                      {shortDate(e.date)} · {name(e.account)}
                      {e.description ? ` · ${e.description}` : ''}
                    </span>
                  </span>
                  <span className="row__meta">
                    <span style={{ color: 'var(--label)' }}>{money(e.amountPence)}</span>
                    {canEdit && (
                      <Button
                        variant="plain"
                        aria-label={`Remove ${e.payee} ${money(e.amountPence)}`}
                        onClick={() => setRemoving(e)}
                      >
                        Remove
                      </Button>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </List>
        )}
      </Section>
      {adding && <AddExpenseSheet today={today} onClose={() => setAdding(false)} />}
      <ConfirmSheet
        open={!!removing}
        title="Remove Expense"
        actionLabel="Remove"
        onConfirm={() =>
          removing &&
          del.mutate(removing.id, {
            onSuccess: () => {
              toast.show('Expense removed');
              setRemoving(null);
            },
          })
        }
        onClose={() => setRemoving(null)}
        loading={del.isPending}
        error={del.error?.message}
      >
        {removing && (
          <p>
            Remove <strong>{money(removing.amountPence)}</strong> to {removing.payee} on{' '}
            {shortDate(removing.date)}? It comes out of the Profit and Loss and the bank balance.
          </p>
        )}
      </ConfirmSheet>
    </Page>
  );
}

/**
 * Add an expense or wages. From a bank line (`fromBank`), the date and amount are the bank's and
 * it's matched to that line when saved.
 */
export function AddExpenseSheet(props: {
  today: string;
  onClose: () => void;
  fromBank?: BankTransactionDto;
}) {
  const fromBank = props.fromBank;
  const add = useAddExpense();
  const addFromBank = useExpenseFromBankLine();
  const members = useMembers();
  const toast = useToast();
  const [date, setDate] = useState(fromBank?.date ?? props.today);
  const [account, setAccount] = useState<ExpenseAccountCode>('449');
  const [payee, setPayee] = useState(fromBank ? titleCase(fromBank.description) : '');
  const [memberId, setMemberId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(
    fromBank ? (Math.abs(fromBank.amountPence) / 100).toFixed(2) : '',
  );
  const [tax, setTax] = useState('');
  const wages = account === WAGES_ACCOUNT;
  const pence = parsePounds(amount);
  const taxPence = tax.trim() ? parsePounds(tax) : 0;
  const memberName = members.data?.find((m) => m.userId === memberId)?.name;
  const who = wages && memberName ? memberName : payee.trim();
  const problem = !who
    ? null
    : amount && pence === null
      ? 'Enter an amount, e.g. 45.00'
      : taxPence === null || (pence !== null && taxPence > pence)
        ? 'Tax can’t be more than the amount'
        : date > props.today
          ? 'The date can’t be in the future'
          : null;
  const ready = !!who && pence !== null && pence > 0 && !problem && !!date;
  const save = () => {
    if (!ready || pence === null) return;
    const done = {
      onSuccess: () => {
        toast.show(`${wages ? 'Wages' : 'Expense'} added · ${money(pence)}`);
        props.onClose();
      },
      onError: (e: Error) => toast.show(e.message, { tone: 'error' }),
    };
    if (fromBank) {
      addFromBank.mutate(
        {
          id: fromBank.id,
          account,
          payee: who,
          description: description.trim(),
          taxPence: taxPence ?? 0,
          memberUserId: wages && memberId ? memberId : null,
        },
        done,
      );
      return;
    }
    add.mutate(
      {
        date,
        account,
        payee: who,
        description: description.trim(),
        amountPence: pence,
        taxPence: taxPence ?? 0,
        memberUserId: wages && memberId ? memberId : null,
      },
      {
        onSuccess: () => {
          toast.show(`${wages ? 'Wages' : 'Expense'} added · ${money(pence)}`);
          props.onClose();
        },
        onError: (e) => toast.show(e.message, { tone: 'error' }),
      },
    );
  };
  return (
    <Sheet
      open
      title={wages ? 'Add Wages' : 'Add Expense'}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={save}
          disabled={!ready}
          loading={add.isPending || addFromBank.isPending}
        >
          Add
        </Button>
      }
    >
      <List className="form-list" label="Expense">
        <SelectField
          label="What for"
          value={account}
          onChange={(e) => setAccount(e.target.value as ExpenseAccountCode)}
        >
          {EXPENSE_ACCOUNT_CODES.map((c) => (
            <option key={c} value={c}>
              {name(c)}
            </option>
          ))}
        </SelectField>
        {wages && (members.data?.length ?? 0) > 0 && (
          <SelectField
            label="Paid to"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
          >
            <option value="">Someone else</option>
            {members.data!.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </SelectField>
        )}
        {!(wages && memberId) && (
          <TextField
            label={wages ? 'Name' : 'Paid to'}
            placeholder={wages ? 'Who was paid' : 'e.g. Island fuel'}
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
          />
        )}
        <TextField
          label="Date"
          type="date"
          value={date}
          max={props.today}
          readOnly={!!fromBank}
          onChange={(e) => setDate(e.target.value)}
        />
        <TextField
          label="Amount (£)"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          readOnly={!!fromBank}
          onChange={(e) => setAmount(e.target.value)}
          error={problem ?? undefined}
        />
        <TextField
          label="Tax included (£)"
          inputMode="decimal"
          placeholder="0.00 (none)"
          value={tax}
          onChange={(e) => setTax(e.target.value)}
        />
        <TextField
          label="Note"
          placeholder={wages ? 'e.g. Week 46' : 'Optional'}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </List>
      <p className="section__footer">Comes out of the business account and off the profit.</p>
    </Sheet>
  );
}
