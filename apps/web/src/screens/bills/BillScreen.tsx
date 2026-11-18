import {
  ALLOCATION_LABELS,
  BILL_KIND_LABELS,
  billTotal,
  formatPence,
  formatQty,
  type BillApplyResultDto,
  type BillDetailDto,
  type BillLineInput,
} from '@lse/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApplyBill, useBill, useDeleteBill, useUpdateBill } from '../../api/bills';
import { useJobs, useSession } from '../../api/hooks';
import { IconPlusCircle, IconReceipt } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
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
  SelectField,
} from '../../components/ui';
import { shortDate } from '../../lib/status';
import { ConfirmSheet } from '../invoices/InvoiceSheets';
import { Change } from '../pricing/Change';
import { ApplySummary, BillLineSheet, type DraftLine } from './BillSheets';
import { BillPayments } from './BillPayments';

export function BillScreen() {
  const { id = '' } = useParams();
  const bill = useBill(id);
  if (bill.isPending)
    return (
      <Page title="Bill" back={{ label: 'Bills', to: '/bills' }}>
        <ListSkeleton />
      </Page>
    );
  if (bill.isError)
    return (
      <Page title="Bill" back={{ label: 'Bills', to: '/bills' }}>
        <EmptyState
          icon={<IconReceipt />}
          title="Couldn’t load this bill"
          message={bill.error.message}
          action={<Button onClick={() => bill.refetch()}>Try again</Button>}
        />
      </Page>
    );
  return <BillView bill={bill.data} />;
}

const toDraft = (l: BillDetailDto['lines'][number]): DraftLine => ({
  code: l.code,
  description: l.description,
  qtyMilli: l.qtyMilli,
  unitCostPence: l.unitCostPence,
  item: l.item,
  updatePrice: l.updatePrice,
  allocation: l.allocation,
});
const toInput = (l: DraftLine): BillLineInput => ({
  code: l.code,
  description: l.description,
  qtyMilli: l.qtyMilli,
  unitCostPence: l.unitCostPence,
  // undefined: let the server match it; null: deliberately not on the list.
  ...(l.item === undefined ? {} : { itemId: l.item?.id ?? null }),
  updatePrice: l.updatePrice,
  allocation: l.allocation,
});

function BillView({ bill: b }: { bill: BillDetailDto }) {
  const isOwner = useSession().data?.role === 'owner';
  const draft = b.status === 'draft';
  const credit = b.kind === 'credit_note';
  const update = useUpdateBill(b);
  const del = useDeleteBill(b.id);
  const apply = useApplyBill(b.id);
  const jobs = useJobs('active');
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [preview, setPreview] = useState<BillApplyResultDto | null>(null);
  const [applied, setApplied] = useState<BillApplyResultDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const lines = b.lines.map(toDraft);

  const saveLines = (next: DraftLine[]) =>
    update.mutate(
      { lines: next.map(toInput) },
      { onError: (e) => toast.show(`Not saved. ${e.message}`, { tone: 'error' }) },
    );
  const openReview = () => {
    setPreview(null);
    setReviewing(true);
    apply.mutate(true, { onSuccess: setPreview });
  };
  const confirmApply = () =>
    apply.mutate(false, {
      onSuccess: (r) => {
        setReviewing(false);
        setApplied(r);
        toast.show(
          `Applied · ${r.priceChanges.length} ${r.priceChanges.length === 1 ? 'price' : 'prices'} updated` +
            (r.jobLines.length ? ` · ${r.jobLines.length} added to job ${r.jobNumber}` : ''),
        );
      },
    });

  return (
    <Page
      title={`${b.supplierName} ${b.reference}`}
      subtitle={
        <>
          {BILL_KIND_LABELS[b.kind]} · {shortDate(`${b.billDate}T12:00:00Z`)}
          {b.dueDate && ` · due ${shortDate(`${b.dueDate}T12:00:00Z`)}`}
          {b.jobId && (
            <>
              {' · '}
              <Link to={`/jobs/${b.jobId}`}>Job {b.jobNumber}</Link>
            </>
          )}
        </>
      }
      back={{ label: 'Bills', to: '/bills' }}
    >
      <div className="hero">
        <div className="hero__amount">
          {credit ? '−' : ''}
          {formatPence(b.totalPence)}
        </div>
        <div className="hero__meta">
          {draft ? <Pill tone="orange">To check</Pill> : <Pill tone="green">Applied</Pill>}
          <span>
            {b.lineCount} {b.lineCount === 1 ? 'line' : 'lines'}
            {draft && b.unmatchedCount > 0 ? ` · ${b.unmatchedCount} not on price list` : ''}
          </span>
        </div>
      </div>

      {draft && (
        <Section
          footer={
            !isOwner
              ? 'The owner checks and applies bills.'
              : 'You’ll see every price, kit and job change before anything is applied.'
          }
        >
          {isOwner && (
            <Button large block onClick={openReview} disabled={!b.lines.length || update.isPending}>
              Review and Apply…
            </Button>
          )}
        </Section>
      )}

      {draft && (
        <Section header="Job" footer="Lines marked Job go onto this job’s materials when applied.">
          <List className="form-list">
            <SelectField
              label="Job"
              value={b.jobId ?? ''}
              onChange={(e) =>
                update.mutate(
                  { jobId: e.target.value || null },
                  { onError: (err) => toast.show(`Not saved. ${err.message}`, { tone: 'error' }) },
                )
              }
            >
              <option value="">None (stock or home)</option>
              {b.jobId && !(jobs.data?.items ?? []).some((j) => j.id === b.jobId) && (
                <option value={b.jobId}>
                  {b.jobNumber} · {b.jobTitle}
                </option>
              )}
              {(jobs.data?.items ?? []).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.number} · {j.title}
                </option>
              ))}
            </SelectField>
          </List>
        </Section>
      )}

      <Section
        header="Lines"
        footer={
          draft
            ? 'Tap a line to fix it, match it to the price list or change where it goes.'
            : undefined
        }
      >
        <List label="Bill lines">
          {b.lines.map((l, i) => {
            const body = (
              <>
                <span className="row__main">
                  <span className="row__title">{l.description}</span>
                  <span className="row__sub">
                    {formatQty(l.qtyMilli)} × {formatPence(l.unitCostPence)}
                    {l.code ? ` · ${l.code}` : ''} · {ALLOCATION_LABELS[l.allocation]}
                    {l.allocation === 'job' && b.jobNumber ? ` ${b.jobNumber}` : ''}
                  </span>
                  <span className="row__sub">
                    {l.item ? (
                      <>
                        <Pill tone="blue">On list</Pill>{' '}
                        {credit || !l.updatePrice || l.item.unitCostPence === l.unitCostPence ? (
                          (l.item.code ?? l.item.description)
                        ) : (
                          <Change
                            from={l.item.unitCostPence}
                            to={l.unitCostPence}
                            label="List cost"
                          />
                        )}
                        {!credit && !l.updatePrice && ' · list cost kept'}
                      </>
                    ) : (
                      <Pill tone="grey">Not on list</Pill>
                    )}
                  </span>
                </span>
                <span className="row__meta num">{formatPence(l.totalPence)}</span>
              </>
            );
            return (
              <li key={l.id}>
                {draft ? (
                  <button type="button" className="row" onClick={() => setEditing(i)}>
                    {body}
                  </button>
                ) : (
                  <div className="row">{body}</div>
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

      {applied && <ApplySummary r={applied} />}

      <BillPayments bill={b} isOwner={isOwner} />

      <Section header="Details">
        <List>
          <li>
            <KeyValueRow
              label="Entered from"
              value={b.source === 'csv' ? 'CSV' : b.source === 'pdf' ? 'PDF (typed)' : 'Typed in'}
            />
          </li>
          {b.fileName && (
            <li>
              <KeyValueRow label="File" value={b.fileName} />
            </li>
          )}
          <li>
            <KeyValueRow label="Total" value={formatPence(billTotal(b.lines))} />
          </li>
          {b.appliedAt && (
            <li>
              <KeyValueRow
                label="Applied"
                value={`${b.appliedByName} · ${new Date(b.appliedAt).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'Europe/Guernsey',
                })}`}
              />
            </li>
          )}
        </List>
      </Section>

      {draft && (
        <Button variant="destructive" block onClick={() => setDeleting(true)}>
          Delete Bill
        </Button>
      )}

      {editing !== null && (
        <BillLineSheet
          line={editing === 'new' ? null : lines[editing]!}
          hasJob={!!b.jobId}
          credit={credit}
          onClose={() => setEditing(null)}
          onSave={(l) =>
            saveLines(
              editing === 'new' ? [...lines, l] : lines.map((x, i) => (i === editing ? l : x)),
            )
          }
          onRemove={
            editing === 'new' ? undefined : () => saveLines(lines.filter((_, i) => i !== editing))
          }
        />
      )}

      <Sheet
        open={reviewing}
        title="Review Changes"
        onClose={() => {
          apply.reset();
          setReviewing(false);
        }}
        action={
          <Button
            variant="plain"
            onClick={confirmApply}
            disabled={!preview}
            loading={apply.isPending && !!preview}
            style={{ fontWeight: 600 }}
          >
            Apply
          </Button>
        }
      >
        {!preview && apply.isPending && <ListSkeleton rows={3} />}
        {apply.isError && (
          <p className="field-error" role="alert">
            {apply.error.message}
          </p>
        )}
        {preview && (
          <>
            <p className="sheet-hint">Nothing has changed yet. Applying locks the bill.</p>
            <ApplySummary r={preview} />
            <Button block large onClick={confirmApply} loading={apply.isPending}>
              Apply {credit ? 'Credit Note' : 'Bill'}
            </Button>
          </>
        )}
      </Sheet>

      <ConfirmSheet
        open={deleting}
        title="Delete Bill"
        actionLabel="Delete"
        loading={del.isPending}
        error={del.error?.message}
        onClose={() => setDeleting(false)}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              toast.show('Bill deleted');
              navigate('/bills');
            },
          })
        }
      >
        <p>
          Delete {b.supplierName} {b.reference}? It hasn’t been applied, so nothing else changes.
        </p>
      </ConfirmSheet>
    </Page>
  );
}
