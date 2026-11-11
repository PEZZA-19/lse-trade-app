import { formatPence, parsePounds, type InvoiceDetailDto } from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import {
  useApproveCreditNote,
  useCreateCreditNote,
  useCreditNote,
  useDeleteCreditNote,
} from '../../api/creditNotes';
import { IconDoc } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  ButtonRow,
  KeyValueRow,
  List,
  ListSkeleton,
  Pill,
  Section,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { shortDate } from '../../lib/status';

/** Draft a credit note: how much comes off the invoice, and why. Nothing changes until approved. */
export function NewCreditNoteSheet(props: {
  open: boolean;
  invoice: InvoiceDetailDto;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const inv = props.invoice;
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const create = useCreateCreditNote(inv);
  const toast = useToast();
  const amountPence = parsePounds(amount);
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const valid =
    amountPence != null && amountPence > 0 && amountPence <= inv.balancePence && !!reason.trim();
  const close = () => {
    create.reset();
    setAmount('');
    setReason('');
    props.onClose();
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || create.isPending) return;
    create.mutate(
      { amountPence: amountPence!, reason: reason.trim() },
      {
        onSuccess: (cn) => {
          toast.show('Draft credit note saved. Approve it to take it off the invoice.');
          close();
          props.onCreated(cn.id);
        },
      },
    );
  };
  return (
    <Sheet
      open={props.open}
      title="New Credit Note"
      onClose={close}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!valid}
          loading={create.isPending}
          style={{ fontWeight: 600 }}
        >
          Save
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section
          footer={
            amountPence != null && amountPence > inv.balancePence
              ? `That’s more than the ${formatPence(inv.balancePence)} owed.`
              : amountPence != null && amountPence > 0 && amountPence <= inv.balancePence
                ? `Invoice ${inv.number} would then be owed ${formatPence(inv.balancePence - amountPence)}.`
                : `Up to ${formatPence(inv.balancePence)}, what’s still owed on invoice ${inv.number}.`
          }
        >
          <List className="form-list">
            <TextField
              label="Amount (£)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              error={fields.amountPence}
              data-autofocus
            />
            <TextAreaField
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Shown on the credit note, e.g. Outside light not fitted"
              error={fields.reason}
            />
          </List>
        </Section>
        {create.isError && !Object.keys(fields).length && (
          <p className="field-error" role="alert">
            {create.error.message}
          </p>
        )}
        <p className="sheet-hint">
          Saved as a draft. Nothing changes on the invoice and nothing is sent until the owner
          approves it.
        </p>
      </form>
    </Sheet>
  );
}

/** One credit note: what it does, preview, and the owner's Approve (or delete while a draft). */
export function CreditNoteSheet(props: {
  id: string | null;
  isOwner: boolean;
  onClose: () => void;
  onPreview: (id: string, title: string, draft: boolean) => void;
}) {
  const q = useCreditNote(props.id);
  const cn = q.data;
  const [step, setStep] = useState<'view' | 'approve' | 'delete'>('view');
  const approve = useApproveCreditNote(cn ?? { id: '', version: 0, invoiceId: '', jobId: '' });
  const del = useDeleteCreditNote(cn ?? { id: '', invoiceId: '', jobId: '' });
  const toast = useToast();
  const close = () => {
    approve.reset();
    del.reset();
    setStep('view');
    props.onClose();
  };
  const draft = cn?.status === 'draft';
  const title = cn ? (cn.number ? `Credit Note ${cn.number}` : 'Draft Credit Note') : 'Credit Note';
  const after = cn ? Math.max(0, cn.invoiceBalancePence - cn.amountPence) : 0;
  const error = (approve.error ?? del.error)?.message ?? null;

  return (
    <Sheet
      open={!!props.id}
      title={
        step === 'approve' ? 'Approve Credit Note' : step === 'delete' ? 'Delete Draft' : title
      }
      onClose={close}
      action={
        step === 'approve' ? (
          <Button
            variant="plain"
            loading={approve.isPending}
            style={{ fontWeight: 600 }}
            onClick={() =>
              approve.mutate(undefined, {
                onSuccess: (r) => {
                  toast.show(
                    `Credit note ${r.number} approved · ${formatPence(r.amountPence)} off invoice ${r.invoiceNumber}` +
                      (r.jobCompleted ? ` · Job ${r.jobNumber} moved to Complete` : ''),
                  );
                  setStep('view');
                },
              })
            }
          >
            Approve
          </Button>
        ) : step === 'delete' ? (
          <Button
            variant="plain"
            loading={del.isPending}
            style={{ fontWeight: 600, color: 'var(--red)' }}
            onClick={() =>
              del.mutate(undefined, {
                onSuccess: () => {
                  toast.show('Draft credit note deleted');
                  close();
                },
              })
            }
          >
            Delete
          </Button>
        ) : null
      }
      cancelLabel={step === 'view' ? 'Done' : 'Back'}
      onCancel={step === 'view' ? undefined : () => setStep('view')}
    >
      {!cn ? (
        <ListSkeleton rows={3} />
      ) : step === 'approve' ? (
        <div className="confirm">
          <p>
            It becomes credit note <strong>{cn.nextNumber}</strong> and{' '}
            <strong>{formatPence(cn.amountPence)}</strong> comes off invoice {cn.invoiceNumber},
            leaving {formatPence(after)} owed.
          </p>
          <p>The number can’t be reused and the credit note can’t be deleted afterwards.</p>
          <p>Nothing is sent to the customer. Share the PDF yourself when you’re ready.</p>
        </div>
      ) : step === 'delete' ? (
        <div className="confirm">
          <p>Delete this draft credit note for {formatPence(cn.amountPence)}?</p>
          <p>It has no number yet, so nothing is lost from the sequence.</p>
        </div>
      ) : (
        <>
          <div className="hero">
            <div className="hero__amount">{formatPence(cn.amountPence)}</div>
            <div className="hero__meta">
              {draft ? <Pill tone="orange">Draft</Pill> : <Pill tone="green">Approved</Pill>}
              <span>off invoice {cn.invoiceNumber}</span>
            </div>
          </div>
          <Section>
            <List>
              <li>
                <KeyValueRow label="Reason" value={cn.reason} />
              </li>
              <li>
                <KeyValueRow
                  label={draft ? 'Owed now' : 'Owed on invoice'}
                  value={formatPence(cn.invoiceBalancePence)}
                />
              </li>
              {draft && (
                <li>
                  <KeyValueRow label="Owed once approved" value={formatPence(after)} strong />
                </li>
              )}
              {cn.issueDate && (
                <li>
                  <KeyValueRow
                    label="Approved"
                    value={`${shortDate(`${cn.issueDate}T12:00:00Z`)}${cn.approvedByName ? ` by ${cn.approvedByName}` : ''}`}
                  />
                </li>
              )}
            </List>
          </Section>
          <Section>
            <List>
              <li>
                <ButtonRow
                  lead={<IconDoc width={22} height={22} color="var(--accent)" />}
                  title="Preview PDF"
                  sub={
                    draft
                      ? 'Draft preview: approve to share it'
                      : `${title} as the customer gets it`
                  }
                  onClick={() => props.onPreview(cn.id, title, draft)}
                  chevron
                />
              </li>
            </List>
          </Section>
          {draft && (
            <Section
              footer={
                props.isOwner
                  ? 'Approving numbers it and takes it off the invoice. Nothing is sent.'
                  : 'The owner approves credit notes.'
              }
            >
              {props.isOwner && (
                <Button block large onClick={() => setStep('approve')}>
                  Approve Credit Note…
                </Button>
              )}
              <Button block variant="destructive" onClick={() => setStep('delete')}>
                Delete Draft
              </Button>
            </Section>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      {step !== 'view' && error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
