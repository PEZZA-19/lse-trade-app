import { formatPence, parsePounds, type BillDetailDto } from '@lse/shared';
import { useState } from 'react';
import { useBillPayments, useRecordBillPayment } from '../../api/business';
import { useAccess } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, KeyValueRow, List, Section, SelectField, TextField } from '../../components/ui';
import { shortDate } from '../../lib/status';

const METHOD: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};
const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(new Date());

/** Money paid to the supplier against an applied bill: what's left to pay, and Record Payment. */
export function BillPayments({ bill, canPay }: { bill: BillDetailDto; canPay: boolean }) {
  const access = useAccess();
  const list = useBillPayments(bill.id, bill.kind === 'bill' && bill.status === 'applied');
  const [open, setOpen] = useState(false);
  if (bill.kind !== 'bill' || bill.status !== 'applied') return null;
  const rows = list.data ?? [];
  const paid = rows.reduce((s, p) => s + p.amountPence, 0);
  const left = bill.totalPence - paid;
  return (
    <Section
      header="Payments"
      footer={
        access.ready && canPay
          ? 'Recording a payment takes it off what you owe and out of the bank on the Business overview.'
          : 'Someone with Accounts access records payments to suppliers.'
      }
    >
      <List label="Payments">
        {rows.map((p) => (
          <li key={p.id}>
            <KeyValueRow
              label={`${shortDate(p.paidOn)} · ${METHOD[p.method] ?? p.method}${p.reference ? ` · ${p.reference}` : ''}`}
              value={formatPence(p.amountPence)}
            />
          </li>
        ))}
        <li>
          <KeyValueRow
            label={left <= 0 ? 'Paid in full' : 'Still to pay'}
            value={
              <span style={left > 0 ? { color: 'var(--orange)' } : { color: 'var(--green)' }}>
                {formatPence(Math.max(0, left))}
              </span>
            }
            strong
          />
        </li>
      </List>
      {canPay && left > 0 && (
        <Button
          variant="secondary"
          block
          onClick={() => setOpen(true)}
          style={{ marginTop: 'var(--space-3)' }}
        >
          Record Payment
        </Button>
      )}
      {open && <PaySheet billId={bill.id} left={left} onClose={() => setOpen(false)} />}
    </Section>
  );
}

function PaySheet({
  billId,
  left,
  onClose,
}: {
  billId: string;
  left: number;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState((left / 100).toFixed(2));
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const pay = useRecordBillPayment(billId);
  const toast = useToast();
  const pence = parsePounds(amount);
  const error =
    pence === null
      ? 'Enter an amount'
      : pence > left
        ? `No more than ${formatPence(left)}`
        : undefined;
  const save = () =>
    pence !== null &&
    pay.mutate(
      {
        amountPence: pence,
        paidOn: date,
        method: method as 'bank_transfer',
        reference: reference || undefined,
      },
      {
        onSuccess: () => {
          toast.show('Payment recorded');
          onClose();
        },
        onError: (e) => toast.show(e.message),
      },
    );
  return (
    <Sheet
      open
      title="Record Payment"
      onClose={onClose}
      action={
        <Button variant="plain" onClick={save} disabled={!!error || !date} loading={pay.isPending}>
          Save
        </Button>
      }
    >
      <List className="form-list" label="Payment">
        <TextField
          label="Amount (£)"
          inputMode="decimal"
          value={amount}
          error={amount ? error : undefined}
          onChange={(e) => setAmount(e.target.value)}
        />
        <TextField
          label="Paid on"
          type="date"
          value={date}
          max={todayIso()}
          onChange={(e) => setDate(e.target.value)}
        />
        <SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(METHOD).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Reference"
          placeholder="Optional"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </List>
    </Sheet>
  );
}
