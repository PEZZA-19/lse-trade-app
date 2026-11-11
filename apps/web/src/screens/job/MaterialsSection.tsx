import {
  formatPence,
  formatQty,
  parsePounds,
  parseQty,
  sellFromCost,
  signedLineTotal,
  type JobDetailDto,
  type JobLineDto,
} from '@lse/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useMe } from '../../api/hooks';
import { useAddJobLine, useDeleteJobLine, useUpdateJobLine } from '../../api/jobDetail';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  ButtonRow,
  KeyValueRow,
  LinkRow,
  List,
  Section,
  SelectField,
  StaticRow,
  TextField,
} from '../../components/ui';
import { LINE_KIND_LABEL } from '../../lib/status';

type Editing = { mode: 'add' } | { mode: 'edit'; line: JobLineDto };
const pounds = (p: number | null) => (p === null ? '' : formatPence(p).replace(/[£,]/g, ''));

/** Materials and extras since the quote: from supplier bills, or added by hand on the job. */
export function MaterialsSection({ job: j }: { job: JobDetailDto }) {
  const me = useMe();
  const [editing, setEditing] = useState<Editing | null>(null);
  const canRecord = !!me.data && me.data.role !== 'accountant';
  const extra = j.lines.filter((l) => l.source !== 'quote');
  const editable = (l: JobLineDto) => canRecord && l.source === 'manual' && !l.invoiced;

  return (
    <Section
      header="Materials and extras"
      footer="From supplier bills and by hand. On a time-and-materials invoice these are billed at the price shown. Lines on an invoice are locked."
    >
      <List label="Materials and extras">
        {extra.map((l) => {
          const sub = `${
            l.source === 'supplier_bill'
              ? 'From supplier bill'
              : `${LINE_KIND_LABEL[l.kind]} · by hand`
          } · ${formatQty(l.qtyMilli)} × ${formatPence(l.unitSellPence)}${l.invoiced ? ' · invoiced' : ''}`;
          const meta = (
            <span className="num" style={{ color: 'var(--label)' }}>
              {formatPence(l.totalPence)}
            </span>
          );
          return (
            <li key={l.id}>
              {editable(l) ? (
                <ButtonRow
                  onClick={() => setEditing({ mode: 'edit', line: l })}
                  title={l.description}
                  sub={sub}
                  meta={meta}
                  chevron
                />
              ) : (
                <StaticRow>
                  <span className="row__main">
                    <span className="row__title">{l.description}</span>
                    <span className="row__sub">{sub}</span>
                  </span>
                  <span className="row__meta">{meta}</span>
                </StaticRow>
              )}
            </li>
          );
        })}
        {extra.length > 0 && (
          <li>
            <KeyValueRow
              label="Total"
              value={formatPence(extra.reduce((a, l) => a + l.totalPence, 0))}
              strong
            />
          </li>
        )}
        {canRecord && (
          <li>
            <ButtonRow
              onClick={() => setEditing({ mode: 'add' })}
              title={<span className="row-action">Add Material…</span>}
            />
          </li>
        )}
        <li>
          <LinkRow
            to="/bills"
            title="Supplier Bills"
            sub="Enter a bill and pick this job to add its materials"
          />
        </li>
      </List>
      {editing && (
        <MaterialSheet
          job={j}
          editing={editing}
          markupBp={me.data?.tenant.defaultMarkupBp ?? 13000}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  );
}

function MaterialSheet(props: {
  job: JobDetailDto;
  editing: Editing;
  markupBp: number;
  onClose: () => void;
}) {
  const { job, editing, markupBp, onClose } = props;
  const line = editing.mode === 'edit' ? editing.line : null;
  const [kind, setKind] = useState<'material' | 'carriage' | 'labour'>(
    line && line.kind !== 'pc_sum' ? line.kind : 'material',
  );
  const [description, setDescription] = useState(line?.description ?? '');
  const [qty, setQty] = useState(line ? formatQty(line.qtyMilli) : '1');
  const [cost, setCost] = useState(pounds(line?.unitCostPence ?? null));
  // An existing price is kept unless changed; a new line follows cost × markup until typed over.
  const [price, setPrice] = useState(line ? pounds(line.unitSellPence) : '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const add = useAddJobLine();
  const update = useUpdateJobLine();
  const remove = useDeleteJobLine();
  const toast = useToast();

  const q = parseQty(qty);
  const c = cost.trim() ? parsePounds(cost) : null;
  const p = price.trim() ? parsePounds(price) : null;
  const suggested = c !== null && c >= 0 ? sellFromCost(c, markupBp) : null;
  const sell = p ?? suggested;
  const qtyError =
    qty.trim() && (q === null || q <= 0) ? 'Enter a quantity, e.g. 2 or 2.5' : undefined;
  const costError =
    cost.trim() && (c === null || c < 0) ? 'Enter an amount, e.g. 12.40' : undefined;
  const priceError =
    price.trim() && (p === null || p < 0) ? 'Enter an amount, e.g. 16.00' : undefined;
  const ready =
    !!description.trim() && !!q && q > 0 && sell !== null && !qtyError && !costError && !priceError;
  const error = add.error ?? update.error ?? remove.error;
  const fields = error instanceof ApiError ? error.fields : {};
  const busy = add.isPending || update.isPending || remove.isPending;

  const save = () => {
    if (!ready || busy) return;
    if (line)
      update.mutate(
        {
          id: line.id,
          description: description.trim(),
          qtyMilli: q!,
          unitCostPence: c,
          unitSellPence: sell,
        },
        { onSuccess: () => (toast.show('Line updated'), onClose()) },
      );
    else
      add.mutate(
        {
          jobId: job.id,
          kind,
          description: description.trim(),
          qtyMilli: q!,
          unitCostPence: c,
          unitSellPence: p,
        },
        { onSuccess: () => (toast.show(`Added to job ${job.number}`), onClose()) },
      );
  };

  if (confirmDelete && line)
    return (
      <Sheet
        open
        title="Delete Line"
        onClose={onClose}
        onCancel={() => setConfirmDelete(false)}
        cancelLabel="Back"
      >
        <p className="sheet__text">Remove “{line.description}” from this job?</p>
        {error && (
          <p className="field-error" role="alert">
            {error.message}
          </p>
        )}
        <Button
          block
          large
          variant="destructive"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(line.id, { onSuccess: () => (toast.show('Line removed'), onClose()) })
          }
        >
          Delete Line
        </Button>
      </Sheet>
    );

  return (
    <Sheet
      open
      title={line ? 'Edit Line' : 'Add Material'}
      onClose={onClose}
      action={
        <Button variant="plain" onClick={save} disabled={!ready} loading={busy}>
          {line ? 'Save' : 'Add'}
        </Button>
      }
    >
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          save();
        }}
      >
        <Section
          footer={`Leave the price empty to charge cost plus your markup (${(markupBp / 100 - 100).toFixed(0)}%). Cost is what you paid; it feeds profit, not the invoice.`}
        >
          <List className="form-list">
            {!line && (
              <SelectField
                label="Type"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="material">Material</option>
                <option value="carriage">Carriage or travel</option>
                <option value="labour">Extra labour</option>
              </SelectField>
            )}
            <TextField
              label="Item"
              placeholder="e.g. 20A RCBO"
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              error={fields.description}
              data-autofocus
            />
            <TextField
              label="Quantity"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              error={qtyError ?? fields.qtyMilli}
            />
            <TextField
              label="Cost each (£)"
              inputMode="decimal"
              placeholder="What you paid"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              error={costError ?? fields.unitCostPence}
            />
            <TextField
              label="Price each (£)"
              inputMode="decimal"
              placeholder={suggested !== null ? pounds(suggested) : 'Charge'}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              error={priceError ?? fields.unitSellPence}
            />
            <li>
              <KeyValueRow
                label="Line total"
                value={q && sell !== null ? formatPence(signedLineTotal(q, sell)) : '—'}
                strong
              />
            </li>
          </List>
        </Section>
        {error && (
          <p className="field-error" role="alert">
            {error.message}
          </p>
        )}
        {line && (
          <div className="button-stack">
            <Button
              variant="plain"
              block
              className="destructive-text"
              onClick={() => setConfirmDelete(true)}
            >
              Delete Line
            </Button>
          </div>
        )}
      </form>
    </Sheet>
  );
}
