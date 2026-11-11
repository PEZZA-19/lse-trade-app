import { formatMinutes, formatPence, parsePounds, type JobInvoicingDto } from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useCreateInvoice, useJobInvoicing } from '../../api/billing';
import { IconCheck, IconPlusCircle } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  ButtonRow,
  LinkRow,
  List,
  ListSkeleton,
  Pill,
  Section,
  TextField,
} from '../../components/ui';
import { INVOICE_STATUS, dueLabel } from '../../lib/status';

/** Invoices for this job, and what's left to bill. Lives on the job: that's where invoicing starts. */
export function JobInvoicesSection({ jobId }: { jobId: string }) {
  const inv = useJobInvoicing(jobId);
  const [creating, setCreating] = useState(false);
  if (inv.isPending) return <ListSkeleton rows={1} />;
  if (inv.isError) return null;
  const d = inv.data;
  const canBill = (d.quote ? d.quote.remainingPence > 0 : false) || d.unbilledMinutes > 0;
  const footer = d.quote
    ? d.quote.remainingPence > 0
      ? `${formatPence(d.quote.invoicedPence)} of ${formatPence(d.quote.totalPence)} (quote ${d.quote.number}) invoiced · ${formatPence(d.quote.remainingPence)} left`
      : `Quote ${d.quote.number} fully invoiced.`
    : d.unbilledMinutes > 0
      ? `${formatMinutes(d.unbilledMinutes)} of time not yet invoiced (${formatPence(d.unbilledLabourPence)}).`
      : d.invoices.length
        ? 'All logged time is invoiced.'
        : 'Time from the job timer can be invoiced here.';
  return (
    <Section header="Invoices" footer={footer}>
      <List label="Invoices for this job">
        {d.invoices.map((i) => {
          const st = INVOICE_STATUS[i.displayStatus];
          return (
            <li key={i.id}>
              <LinkRow
                to={`/invoices/${i.id}`}
                title={i.number ? `Invoice ${i.number}` : 'Draft invoice'}
                sub={
                  <>
                    <Pill tone={st.tone}>{st.label}</Pill> {dueLabel(i)}
                  </>
                }
                meta={<span className="num">{formatPence(i.totalPence)}</span>}
              />
            </li>
          );
        })}
        <li>
          <ButtonRow
            onClick={() => setCreating(true)}
            lead={
              <IconPlusCircle
                width={22}
                height={22}
                color={canBill ? 'var(--accent)' : 'var(--label-3)'}
              />
            }
            title={
              <span style={{ color: canBill ? 'var(--accent)' : 'var(--label-2)' }}>
                New invoice…
              </span>
            }
          />
        </li>
      </List>
      {creating && <NewInvoiceSheet open data={d} onClose={() => setCreating(false)} />}
    </Section>
  );
}

type Choice = 'tm' | 'whole' | 'deposit' | 'percent' | 'remainder';

/** Pick how to invoice: time and materials, or from the quote (whole, deposit, percentage, rest). */
export function NewInvoiceSheet(props: {
  open: boolean;
  data: JobInvoicingDto;
  onClose: () => void;
}) {
  const d = props.data;
  const q = d.quote;
  const options: { value: Choice; title: string; sub: string; disabled?: boolean }[] = [];
  if (q) {
    const started = q.invoicedPence > 0;
    if (!started)
      options.push({
        value: 'whole',
        title: 'Whole quote',
        sub: `${formatPence(q.totalPence)}, every accepted line`,
      });
    options.push({ value: 'deposit', title: 'Deposit', sub: 'A fixed amount up front' });
    options.push({
      value: 'percent',
      title: 'Percentage',
      sub: `A share of ${formatPence(q.totalPence)}`,
    });
    if (started)
      options.push({
        value: 'remainder',
        title: 'Remainder',
        sub: `${formatPence(q.remainingPence)}: the quote less what’s been invoiced`,
      });
  }
  options.push({
    value: 'tm',
    title: 'Time and materials',
    sub: d.unbilledMinutes
      ? `${formatMinutes(d.unbilledMinutes)} of timer entries at your labour rate`
      : 'No unbilled time on this job yet',
    disabled: !d.unbilledMinutes && !d.unbilledMaterialsPence,
  });
  const firstEnabled = options.find((o) => !o.disabled)?.value ?? 'tm';
  const [choice, setChoice] = useState<Choice>(firstEnabled);
  const [amount, setAmount] = useState('');
  const [percent, setPercent] = useState('30');
  const create = useCreateInvoice(d.jobId);
  const navigate = useNavigate();
  const toast = useToast();
  const fullyInvoiced = q ? q.remainingPence <= 0 : false;
  const pct = Number(percent);
  const amountPence = parsePounds(amount);
  const valid =
    !options.find((o) => o.value === choice)?.disabled &&
    !(fullyInvoiced && choice !== 'tm') &&
    (choice !== 'deposit' || (amountPence != null && amountPence > 0)) &&
    (choice !== 'percent' || (pct > 0 && pct < 100 && /^\d+(\.\d{1,2})?$/.test(percent)));
  const close = () => {
    create.reset();
    props.onClose();
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || create.isPending) return;
    const input =
      choice === 'tm'
        ? ({ source: 'job' } as const)
        : choice === 'deposit'
          ? ({ source: 'quote', mode: 'deposit', amountPence: amountPence! } as const)
          : choice === 'percent'
            ? ({ source: 'quote', mode: 'percent', percentBp: Math.round(pct * 100) } as const)
            : ({ source: 'quote', mode: choice } as const);
    create.mutate(input, {
      onSuccess: (inv) => {
        toast.show(`Draft invoice created · ${formatPence(inv.totalPence)}`);
        close();
        navigate(`/invoices/${inv.id}`);
      },
    });
  };
  return (
    <Sheet
      open={props.open}
      title="New Invoice"
      onClose={close}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!valid}
          loading={create.isPending}
          style={{ fontWeight: 600 }}
        >
          Create
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section
          header={q ? `From quote ${q.number}` : undefined}
          footer="Creates a draft. Nothing is sent: you check it, then approve it."
        >
          <List label="How to invoice">
            {options.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  className="row"
                  aria-pressed={choice === o.value}
                  disabled={o.disabled || (fullyInvoiced && o.value !== 'tm')}
                  onClick={() => setChoice(o.value)}
                  style={o.disabled ? { opacity: 0.5 } : undefined}
                >
                  <span className="row__main">
                    <span className="row__title">{o.title}</span>
                    <span className="row__sub">{o.sub}</span>
                  </span>
                  {choice === o.value && (
                    <IconCheck width={20} height={20} color="var(--accent)" aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </List>
        </Section>
        {choice === 'deposit' && (
          <Section footer={q ? `Up to ${formatPence(q.remainingPence)}.` : undefined}>
            <List className="form-list">
              <TextField
                label="Amount (£)"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                data-autofocus
              />
            </List>
          </Section>
        )}
        {choice === 'percent' && q && (
          <Section
            footer={
              pct > 0 && pct < 100
                ? `${formatPence(Math.round((q.totalPence * pct) / 100))} of ${formatPence(q.totalPence)}`
                : 'Between 1% and 99%. Use Whole quote for 100%.'
            }
          >
            <List className="form-list">
              <TextField
                label="Percentage (%)"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                inputMode="decimal"
                data-autofocus
              />
            </List>
          </Section>
        )}
        {create.isError && (
          <p className="field-error" role="alert">
            {create.error.message}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
