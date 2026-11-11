import { formatPence, reconcileStatement, type ReadStatement, type ReconRow } from '@lse/shared';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useBills, useSuppliers } from '../../api/bills';
import { IconReceipt } from '../../components/icons';
import {
  EmptyState,
  KeyValueRow,
  LinkRow,
  List,
  Page,
  Pill,
  Section,
  StaticRow,
} from '../../components/ui';
import { shortDate } from '../../lib/status';
import { openStatement, readPdfFile, STATEMENT_KEY } from './PdfImport';

const day = (iso: string) => shortDate(`${iso}T12:00:00Z`);
const TYPE_LABEL = { INV: 'Invoice', CRN: 'Credit', CAS: 'Payment', DIS: 'Discount' } as const;

/** A file picker that reads a supplier statement PDF and opens the reconciliation. */
export function StatementPicker(props: { label?: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<'idle' | 'reading' | string>('idle');
  return (
    <>
      <label className="btn btn--secondary btn--block" style={{ cursor: 'pointer' }}>
        {state === 'reading' ? 'Reading…' : (props.label ?? 'Check a Statement…')}
        <input
          type="file"
          accept="application/pdf,.pdf"
          aria-label="Statement PDF"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setState('reading');
            try {
              const r = await readPdfFile(f);
              if (r.kind === 'statement') {
                setState('idle');
                openStatement(navigate, r.statement, f.name);
              } else
                setState(
                  r.kind === 'bills'
                    ? 'That PDF is a bill, not a statement. Add it with New Bill.'
                    : 'There’s no statement reader for that layout yet (CI Lighting so far).',
                );
            } catch {
              setState('That file could not be read as a PDF.');
            }
          }}
        />
      </label>
      {state !== 'idle' && state !== 'reading' && (
        <p className="field-error" role="alert">
          {state}
        </p>
      )}
    </>
  );
}

function loadStatement(): { statement: ReadStatement; fileName: string } | null {
  try {
    const raw = sessionStorage.getItem(STATEMENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function Row({ r }: { r: ReconRow }) {
  const sub = `${day(r.date)} · ${TYPE_LABEL[r.type]}${r.yourReference ? ` · ${r.yourReference}` : ''}${
    r.flag === 'settled' ? ' · settled' : r.flag === 'outstanding' ? ' · unpaid' : ''
  }`;
  const amount = `${r.type === 'INV' ? '' : '−'}${formatPence(r.amountPence)}`;
  if (r.bill)
    return (
      <li>
        <LinkRow
          to={`/bills/${r.bill.id}`}
          title={r.reference}
          sub={
            r.match === 'amount_differs'
              ? `${sub} · app has ${formatPence(r.bill.totalPence)} (${r.differencePence! > 0 ? '+' : '−'}${formatPence(Math.abs(r.differencePence!))})`
              : sub
          }
          meta={<span className="num">{amount}</span>}
        />
      </li>
    );
  return (
    <li>
      <StaticRow>
        <span className="row__main">
          <span className="row__title">{r.reference}</span>
          <span className="row__sub">{sub}</span>
        </span>
        <span className="row__meta num">{amount}</span>
      </StaticRow>
    </li>
  );
}

/**
 * Supplier statement against the bills held in the app: what's missing, what differs, and the
 * balance the supplier says is due. Read-only: entering bills or querying the supplier is Joe's call.
 */
export function StatementScreen() {
  const [loaded] = useState(loadStatement);
  const suppliers = useSuppliers();
  const s = loaded?.statement;
  const supplier = (suppliers.data ?? []).find(
    (x) => s && x.name.toLowerCase() === s.supplier.toLowerCase(),
  );
  const bills = useBills('all', supplier?.id);
  const rec = useMemo(
    () =>
      s
        ? reconcileStatement(
            s,
            supplier ? (bills.data ?? []).filter((b) => b.supplierId === supplier.id) : [],
          )
        : null,
    [s, supplier, bills.data],
  );

  if (!s || !rec)
    return (
      <Page title="Statement" back={{ label: 'Bills', to: '/bills' }}>
        <EmptyState
          icon={<IconReceipt />}
          title="No statement open"
          message="Choose a supplier statement PDF to check it against your bills."
          action={<StatementPicker label="Choose Statement…" />}
        />
      </Page>
    );

  const missing = rec.rows.filter((r) => r.match === 'missing');
  const differs = rec.rows.filter((r) => r.match === 'amount_differs');
  const matched = rec.rows.filter((r) => r.match === 'matched');
  const payments = rec.rows.filter((r) => r.match === 'payment');
  return (
    <Page title="Statement" back={{ label: 'Bills', to: '/bills' }}>
      <Section
        header={`${s.supplier}${s.account ? ` · Account ${s.account}` : ''}`}
        aside={
          s.chainOk ? <Pill tone="green">Balance checks</Pill> : <Pill tone="orange">Check</Pill>
        }
        footer={`Read from ${loaded!.fileName}${s.date ? `, dated ${day(s.date)}` : ''}. Nothing is changed by checking a statement.`}
      >
        <List className="form-list" label="Statement summary">
          <KeyValueRow
            label="Balance due (per statement)"
            value={formatPence(rec.closingPence)}
            strong
          />
          <KeyValueRow label="Unpaid items listed" value={formatPence(rec.outstandingPence)} />
          <KeyValueRow label="Matched" value={String(rec.counts.matched)} />
          <KeyValueRow label="Different amount" value={String(rec.counts.amountDiffers)} />
          <KeyValueRow label="Not in the app" value={String(rec.counts.missing)} />
        </List>
        {s.problems.length > 0 && (
          <ul className="problem-list" aria-label="Things to check">
            {s.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </Section>
      {!supplier && (
        <p className="sheet-hint" role="status">
          No supplier called “{s.supplier}” in the app yet, so every invoice shows as missing.
        </p>
      )}
      {missing.length > 0 && (
        <Section
          header={`Not in the app (${missing.length})`}
          footer="Enter these from their bill PDFs, or ask the supplier for copies."
        >
          <List label="Not in the app">
            {missing.map((r, i) => (
              <Row key={i} r={r} />
            ))}
          </List>
        </Section>
      )}
      {differs.length > 0 && (
        <Section header={`Different amount (${differs.length})`}>
          <List label="Different amount">
            {differs.map((r, i) => (
              <Row key={i} r={r} />
            ))}
          </List>
        </Section>
      )}
      {rec.notOnStatement.length > 0 && (
        <Section header={`In the app, not on the statement (${rec.notOnStatement.length})`}>
          <List label="Not on the statement">
            {rec.notOnStatement.map((b) => (
              <li key={b.id}>
                <LinkRow
                  to={`/bills/${b.id}`}
                  title={b.reference}
                  sub={day(b.billDate)}
                  meta={<span className="num">{formatPence(b.totalPence)}</span>}
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      {matched.length > 0 && (
        <Section header={`Matched (${matched.length})`}>
          <List label="Matched">
            {matched.map((r, i) => (
              <Row key={i} r={r} />
            ))}
          </List>
        </Section>
      )}
      {payments.length > 0 && (
        <Section header="Payments and discounts">
          <List label="Payments">
            {payments.map((r, i) => (
              <Row key={i} r={r} />
            ))}
          </List>
        </Section>
      )}
      <StatementPicker label="Check Another Statement…" />
    </Page>
  );
}
