import { BILL_KIND_LABELS, billLinesFromCsv, formatPence, type BillKind } from '@lse/shared';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateBill, useSuppliers } from '../../api/bills';
import { ApiError } from '../../api/client';
import { useJobs } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, List, Section, Segmented, SelectField, TextField } from '../../components/ui';
import { todayIso } from '../../lib/status';

type Entry = 'manual' | 'csv' | 'pdf';
const ENTRY: { value: Entry; label: string }[] = [
  { value: 'manual', label: 'By Hand' },
  { value: 'csv', label: 'CSV' },
  { value: 'pdf', label: 'PDF' },
];
const KINDS: { value: BillKind; label: string }[] = [
  { value: 'bill', label: BILL_KIND_LABELS.bill },
  { value: 'credit_note', label: BILL_KIND_LABELS.credit_note },
];

/**
 * Enter a supplier bill or credit note. Lines can be typed afterwards, read from a CSV export, or
 * typed while looking at the supplier's PDF (reading PDFs automatically comes later).
 */
export function NewBillSheet(props: { onClose: () => void; jobId?: string }) {
  const suppliers = useSuppliers();
  const jobs = useJobs('active');
  const create = useCreateBill();
  const navigate = useNavigate();
  const toast = useToast();
  const [supplier, setSupplier] = useState('');
  const [kind, setKind] = useState<BillKind>('bill');
  const [reference, setReference] = useState('');
  const [billDate, setBillDate] = useState(todayIso());
  const [jobId, setJobId] = useState(props.jobId ?? '');
  const [entry, setEntry] = useState<Entry>('manual');
  const [csv, setCsv] = useState('');
  const [pdf, setPdf] = useState<File | null>(null);
  const parsed = useMemo(() => (csv.trim() ? billLinesFromCsv(csv) : null), [csv]);
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const csvTotal =
    parsed?.lines.reduce((t, l) => t + Math.ceil((l.qtyMilli * l.unitCostPence) / 1000), 0) ?? 0;
  const ready =
    supplier.trim() && reference.trim() && billDate && (entry !== 'csv' || !!parsed?.lines.length);

  const submit = () =>
    create.mutate(
      {
        supplier: supplier.trim(),
        kind,
        reference: reference.trim(),
        billDate,
        jobId: jobId || null,
        source: entry,
        fileName: entry === 'pdf' ? (pdf?.name ?? null) : null,
        lines: entry === 'csv' ? (parsed?.lines ?? []) : [],
      },
      {
        onSuccess: (b) => {
          toast.show(
            b.lines.length
              ? `${b.lines.length} lines · ${b.lines.length - b.unmatchedCount} matched to the price list`
              : 'Bill started. Add its lines.',
          );
          props.onClose();
          navigate(`/bills/${b.id}`);
        },
      },
    );

  return (
    <Sheet
      open
      title={kind === 'bill' ? 'New Bill' : 'New Credit Note'}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={submit}
          disabled={!ready}
          loading={create.isPending}
          style={{ fontWeight: 600 }}
        >
          {entry === 'manual' || entry === 'pdf' ? 'Next' : 'Add'}
        </Button>
      }
    >
      <Segmented label="Type" value={kind} onChange={setKind} options={KINDS} />
      <Section>
        <List className="form-list">
          <TextField
            label="Supplier"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            list="supplier-names"
            autoComplete="off"
            placeholder="e.g. Island Electrical"
            error={fields.supplier}
            data-autofocus
          />
          <TextField
            label={kind === 'bill' ? 'Bill reference' : 'Credit note ref'}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. GUR/334230"
            error={fields.reference}
          />
          <TextField
            label="Date"
            type="date"
            value={billDate}
            onChange={(e) => setBillDate(e.target.value)}
            error={fields.billDate}
          />
          <SelectField label="Job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">None (stock or home)</option>
            {(jobs.data?.items ?? []).map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} · {j.title}
              </option>
            ))}
          </SelectField>
        </List>
      </Section>
      <datalist id="supplier-names">
        {(suppliers.data ?? []).map((s) => (
          <option key={s.id} value={s.name} />
        ))}
      </datalist>

      <Section header="Lines">
        <Segmented label="Lines from" value={entry} onChange={setEntry} options={ENTRY} />
      </Section>
      {entry === 'manual' && <p className="sheet-hint">You’ll add the lines on the next screen.</p>}
      {entry === 'csv' && (
        <>
          <Section footer="Needs Description and a Unit cost or Total column; Code and Qty are optional. Lines match the price list by code, then supplier and description.">
            <List className="form-list">
              <li>
                <div className="row">
                  <textarea
                    className="field__input import-box"
                    aria-label="Bill CSV"
                    placeholder={'Code,Description,Qty,Unit cost\nTE25,2.5mm twin & earth,100,1.18'}
                    value={csv}
                    onChange={(e) => setCsv(e.target.value)}
                  />
                </div>
              </li>
            </List>
          </Section>
          <label className="btn btn--secondary btn--block" style={{ cursor: 'pointer' }}>
            Choose CSV File…
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setCsv(await f.text());
              }}
            />
          </label>
          {parsed && (
            <p className={parsed.lines.length ? 'sheet-hint' : 'field-error'} role="status">
              {parsed.lines.length} {parsed.lines.length === 1 ? 'line' : 'lines'} read ·{' '}
              {formatPence(csvTotal)}
              {parsed.errors.length > 0 &&
                ` · ${parsed.errors.length} skipped (${parsed.errors
                  .slice(0, 2)
                  .map((e) => `row ${e.row}: ${e.message}`)
                  .join('; ')})`}
            </p>
          )}
        </>
      )}
      {entry === 'pdf' && (
        <>
          <label className="btn btn--secondary btn--block" style={{ cursor: 'pointer' }}>
            {pdf ? `PDF: ${pdf.name}` : 'Choose PDF…'}
            <input
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => setPdf(e.target.files?.[0] ?? null)}
            />
          </label>
          {pdf && (
            <Button
              variant="plain"
              block
              onClick={() => window.open(URL.createObjectURL(pdf), '_blank', 'noopener')}
            >
              Open PDF to Read It
            </Button>
          )}
          <p className="sheet-hint">
            Type the lines on the next screen while you look at the PDF. The file name is kept on
            the bill; storing the PDF itself and reading it automatically come later.
          </p>
        </>
      )}
      {create.isError && !Object.keys(fields).length && (
        <p className="field-error" role="alert">
          {create.error.message}
        </p>
      )}
    </Sheet>
  );
}
