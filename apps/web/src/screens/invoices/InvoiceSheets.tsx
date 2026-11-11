import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  formatPence,
  formatQty,
  parsePounds,
  parseQty,
  signedLineTotal,
  type InvoiceDetailDto,
  type InvoiceLineInput,
  type PaymentMethod,
} from '@lse/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { useRecordPayment } from '../../api/billing';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, KeyValueRow, List, Section, SelectField, TextField } from '../../components/ui';
import { todayIso } from '../../lib/status';

/** One explicit tap for a decision: says exactly what will and won't happen. */
export function ConfirmSheet(props: {
  open: boolean;
  title: string;
  actionLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={props.open}
      title={props.title}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={props.onConfirm}
          loading={props.loading}
          style={{ fontWeight: 600 }}
        >
          {props.actionLabel}
        </Button>
      }
    >
      <div className="confirm">{props.children}</div>
      {props.error && (
        <p className="field-error" role="alert">
          {props.error}
        </p>
      )}
      <Button block large onClick={props.onConfirm} loading={props.loading}>
        {props.actionLabel}
      </Button>
    </Sheet>
  );
}

/** Owner records money received: full balance by default, or a part payment. Needs signal. */
export function PaymentSheet(props: {
  open: boolean;
  invoice: InvoiceDetailDto;
  onClose: () => void;
}) {
  const inv = props.invoice;
  const blank = () => ({
    amount: (inv.balancePence / 100).toFixed(2),
    paidOn: todayIso(),
    method: 'bank_transfer' as PaymentMethod,
    reference: '',
  });
  const [form, setForm] = useState(blank);
  const pay = useRecordPayment(inv);
  const toast = useToast();
  const amountPence = parsePounds(form.amount);
  const fields = pay.error instanceof ApiError ? pay.error.fields : {};
  const valid = amountPence != null && amountPence > 0 && amountPence <= inv.balancePence;
  const close = () => {
    pay.reset();
    setForm(blank());
    props.onClose();
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || pay.isPending) return;
    pay.mutate(
      {
        amountPence: amountPence!,
        paidOn: form.paidOn,
        method: form.method,
        reference: form.reference,
      },
      {
        onSuccess: (r) => {
          toast.show(
            r.status === 'paid'
              ? `Invoice ${r.number} paid in full${r.jobCompleted ? ` · Job ${r.jobNumber} moved to Complete` : ''}`
              : `${formatPence(amountPence!)} recorded · ${formatPence(r.balancePence)} still owed`,
          );
          close();
        },
      },
    );
  };
  const full = amountPence === inv.balancePence;
  return (
    <Sheet
      open={props.open}
      title="Record Payment"
      onClose={close}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!valid}
          loading={pay.isPending}
          style={{ fontWeight: 600 }}
        >
          Record
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section
          footer={
            amountPence != null && amountPence > inv.balancePence
              ? `That’s more than the ${formatPence(inv.balancePence)} owed.`
              : full
                ? `Pays invoice ${inv.number} in full.`
                : valid
                  ? `Part payment: ${formatPence(inv.balancePence - amountPence!)} will still be owed.`
                  : undefined
          }
        >
          <List className="form-list">
            <TextField
              label="Amount (£)"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              inputMode="decimal"
              error={fields.amountPence}
              data-autofocus
            />
            <TextField
              label="Date paid"
              type="date"
              value={form.paidOn}
              max={todayIso()}
              onChange={(e) => setForm((f) => ({ ...f, paidOn: e.target.value }))}
              error={fields.paidOn}
            />
            <SelectField
              label="Method"
              value={form.method}
              onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as PaymentMethod }))}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Reference"
              value={form.reference}
              onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
              placeholder="Optional"
              autoComplete="off"
            />
          </List>
        </Section>
        {pay.isError && !Object.keys(fields).length && (
          <p className="field-error" role="alert">
            Not recorded. {pay.error.message}
          </p>
        )}
        <Button block large type="submit" disabled={!valid} loading={pay.isPending}>
          {valid ? `Record ${formatPence(amountPence!)}` : 'Record payment'}
        </Button>
        <p className="section__footer">
          Only you can record payments. It shows as paid only once you’ve tapped this.
        </p>
      </form>
    </Sheet>
  );
}

/** Edit one line of a draft invoice. */
export function InvoiceLineSheet(props: {
  open: boolean;
  line: InvoiceLineInput | null;
  onSave: (l: InvoiceLineInput) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const init = props.line;
  const [form, setForm] = useState(() => ({
    description: init?.description ?? '',
    qty: formatQty(init?.qtyMilli ?? 1000),
    price: init ? (init.unitPricePence / 100).toFixed(2) : '',
  }));
  const qty = parseQty(form.qty);
  const price = parsePounds(form.price);
  const valid = !!form.description.trim() && qty != null && qty !== 0 && price != null;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    props.onSave({
      kind: init?.kind ?? 'material',
      description: form.description.trim(),
      qtyMilli: qty!,
      unitPricePence: price!,
      taxRateBp: init?.taxRateBp ?? 0,
    });
    props.onClose();
  };
  return (
    <Sheet
      open={props.open}
      title={init ? 'Edit Line' : 'Add Line'}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!valid}
          style={{ fontWeight: 600 }}
        >
          Done
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section>
          <List className="form-list">
            <TextField
              label="Description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              data-autofocus
            />
            <TextField
              label="Quantity"
              value={form.qty}
              inputMode="decimal"
              onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
            />
            <TextField
              label="Price each (£)"
              value={form.price}
              inputMode="decimal"
              onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
            />
          </List>
        </Section>
        <Section>
          <List>
            <li>
              <KeyValueRow
                label="Line total"
                value={valid ? formatPence(signedLineTotal(qty!, price!)) : '—'}
                strong
              />
            </li>
          </List>
        </Section>
        {props.onDelete && (
          <Button
            variant="destructive"
            block
            onClick={() => {
              props.onDelete?.();
              props.onClose();
            }}
          >
            Delete line
          </Button>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
