import {
  BILL_KIND_LABELS,
  formatPence,
  formatQty,
  readBillToCreate,
  readPdfPages,
  suggestJob,
  type BillDetailDto,
  type PdfRead,
  type ReadBill,
  type ReadStatement,
} from '@lse/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, newIdempotencyKey } from '../../api/client';
import { useJobs } from '../../api/hooks';
import { useToast } from '../../components/Toast';
import {
  Button,
  KeyValueRow,
  List,
  Pill,
  Section,
  SelectField,
  StaticRow,
} from '../../components/ui';
import { shortDate } from '../../lib/status';

const formatDate = (iso: string) => shortDate(`${iso}T12:00:00Z`);

export const STATEMENT_KEY = 'lse-statement';

/** Reads a PDF on this device (pdf.js): the file never leaves it unless the AI helper is asked. */
export async function readPdfFile(file: File): Promise<PdfRead> {
  const { extractPdfPages } = await import('@lse/shared/pdftext');
  return readPdfPages(await extractPdfPages(new Uint8Array(await file.arrayBuffer())));
}

export function openStatement(
  navigate: ReturnType<typeof useNavigate>,
  statement: ReadStatement,
  fileName: string,
) {
  sessionStorage.setItem(STATEMENT_KEY, JSON.stringify({ statement, fileName }));
  navigate('/suppliers/statement');
}

type AiReply =
  { ok: true; bill: ReadBill; aiCallId: string; provider: string } | { ok: false; message: string };

/**
 * Bill PDFs from CEF and DOCI are read by built-in readers; a PDF with several invoices becomes
 * several drafts. Other layouts can go to the AI helper. Every route ends in draft bills that
 * still need checking and applying.
 */
export function PdfImport(props: { onClose: () => void; jobId?: string }) {
  const jobs = useJobs('active');
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'reading' | 'ai' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<PdfRead | null>(null);
  const [bills, setBills] = useState<ReadBill[]>([]);
  const [jobFor, setJobFor] = useState<Record<number, string>>({});
  const [saveErrors, setSaveErrors] = useState<Record<number, string>>({});
  const [keys] = useState(() => Array.from({ length: 50 }, newIdempotencyKey));
  const jobList = useMemo(() => jobs.data?.items ?? [], [jobs.data]);

  const suggestions = useMemo(
    () => bills.map((b) => suggestJob([b.orderNumber, b.yourReference], jobList)),
    [bills, jobList],
  );
  const jobOf = (i: number) => jobFor[i] ?? props.jobId ?? suggestions[i]?.jobId ?? '';

  const choose = async (f: File | null) => {
    setFile(f);
    setRead(null);
    setBills([]);
    setError(null);
    setSaveErrors({});
    setJobFor({});
    if (!f) return;
    setBusy('reading');
    try {
      const r = await readPdfFile(f);
      if (r.kind === 'statement') {
        props.onClose();
        openStatement(navigate, r.statement, f.name);
        return;
      }
      setRead(r);
      if (r.kind === 'bills') setBills(r.bills);
    } catch {
      setError('That file could not be read as a PDF.');
    } finally {
      setBusy(null);
    }
  };

  const askAi = async () => {
    if (read?.kind !== 'unknown') return;
    setBusy('ai');
    setError(null);
    try {
      const r = await api<AiReply>('POST', '/supplier-bills/read', {
        text: read.text.slice(0, 60_000),
        fileName: file?.name ?? null,
      });
      if (r.ok) setBills([r.bill]);
      else setError(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI helper could not read it.');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('saving');
    const saved: BillDetailDto[] = [];
    const errors: Record<number, string> = {};
    for (const [i, b] of bills.entries()) {
      try {
        saved.push(
          await api<BillDetailDto>(
            'POST',
            '/supplier-bills',
            readBillToCreate(b, { fileName: file?.name ?? null, jobId: jobOf(i) || null }),
            { idempotencyKey: keys[i] },
          ),
        );
      } catch (e) {
        errors[i] = e instanceof ApiError ? e.message : 'Could not save';
      }
    }
    setBusy(null);
    setSaveErrors(errors);
    void qc.invalidateQueries({ queryKey: ['bills'] });
    void qc.invalidateQueries({ queryKey: ['suppliers'] });
    if (Object.keys(errors).length) {
      if (saved.length) toast.show(`${saved.length} saved as drafts; see the others below`);
      setBills((all) => all.filter((_, i) => errors[i]));
      setSaveErrors(Object.fromEntries(Object.values(errors).map((m, n) => [n, m])));
      setJobFor({});
      return;
    }
    props.onClose();
    if (saved.length === 1) {
      toast.show('Draft bill saved. Check it, then apply it.');
      navigate(`/bills/${saved[0]!.id}`);
    } else {
      toast.show(`${saved.length} draft bills saved. Check and apply each one.`);
      navigate('/bills');
    }
  };

  return (
    <>
      <label className="btn btn--secondary btn--block" style={{ cursor: 'pointer' }}>
        {busy === 'reading' ? 'Reading…' : file ? `PDF: ${file.name}` : 'Choose PDF…'}
        <input
          type="file"
          accept="application/pdf,.pdf"
          aria-label="Bill PDF"
          hidden
          onChange={(e) => void choose(e.target.files?.[0] ?? null)}
        />
      </label>
      {!file && (
        <p className="sheet-hint">
          CEF and DOCI invoices and CI Lighting statements are read on this device. A PDF with
          several invoices becomes several draft bills. Nothing changes until you apply each one.
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {read?.kind === 'unknown' && !bills.length && (
        <Section footer="The AI helper drafts the bill from the PDF’s text. Check every line before saving.">
          <p className="sheet-hint" role="status">
            There’s no built-in reader for this layout yet.
          </p>
          <Button variant="secondary" block onClick={askAi} loading={busy === 'ai'}>
            Read with AI Helper
          </Button>
        </Section>
      )}
      {read?.kind === 'bills' && bills.length > 1 && (
        <p className="sheet-hint" role="status">
          {bills.length} invoices found in this PDF.
        </p>
      )}
      {bills.map((b, i) => (
        <Section
          key={`${b.reference}-${i}`}
          header={`${b.supplier} · ${b.reference || 'No reference'}`}
          aside={b.adds ? <Pill tone="green">Adds up</Pill> : <Pill tone="orange">Check</Pill>}
          footer={
            suggestions[i] && !jobFor[i] && !props.jobId
              ? `Job suggested from the order reference: ${suggestions[i]!.why.toLowerCase()}.`
              : undefined
          }
        >
          <List className="form-list" label={`${b.supplier} ${b.reference}`}>
            <KeyValueRow label="Type" value={BILL_KIND_LABELS[b.kind]} />
            <KeyValueRow label="Date" value={b.billDate ? formatDate(b.billDate) : 'Not found'} />
            {b.dueDate && <KeyValueRow label="Due" value={formatDate(b.dueDate)} />}
            {b.orderNumber && <KeyValueRow label="Order no." value={b.orderNumber} />}
            {b.yourReference && <KeyValueRow label="Your ref" value={b.yourReference} />}
            {b.lines.map((l, n) => (
              <StaticRow key={n}>
                <span className="row__main">
                  <span className="row__title">{l.description}</span>
                  <span className="row__sub">
                    {formatQty(l.qtyMilli)} × {formatPence(l.unitPricePence)}
                    {l.discountBp ? ` less ${l.discountBp / 100}%` : ''}
                    {l.code ? ` · ${l.code}` : ''}
                    {l.rrpPence ? ` · RRP ${formatPence(l.rrpPence)}` : ''}
                  </span>
                </span>
                <span className="row__meta num">{formatPence(l.totalPence)}</span>
              </StaticRow>
            ))}
            <KeyValueRow
              label="Total"
              value={b.totalPence == null ? '—' : formatPence(b.totalPence)}
              strong
            />
            <SelectField
              label="Job"
              value={jobOf(i)}
              onChange={(e) => setJobFor((m) => ({ ...m, [i]: e.target.value }))}
            >
              <option value="">None (stock or home)</option>
              {jobList.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.number} · {j.title}
                </option>
              ))}
            </SelectField>
          </List>
          {b.problems.length > 0 && (
            <ul className="problem-list" aria-label="Things to check">
              {b.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {saveErrors[i] && (
            <p className="field-error" role="alert">
              {saveErrors[i]}
            </p>
          )}
        </Section>
      ))}
      {bills.length > 0 && (
        <Button
          variant="primary"
          block
          onClick={save}
          loading={busy === 'saving'}
          disabled={bills.some((b) => !b.billDate || !b.reference || !b.lines.length)}
        >
          {bills.length === 1 ? 'Save as Draft' : `Save ${bills.length} Drafts`}
        </Button>
      )}
    </>
  );
}
