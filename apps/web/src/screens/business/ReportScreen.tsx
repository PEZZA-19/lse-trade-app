import {
  ACCOUNTS,
  COMPARISON_LABEL,
  RANGE_LABEL,
  accountTransactions,
  aged,
  balanceSheet,
  budgetVsActual,
  cashFlow,
  compareRange,
  presetRange,
  profitAndLoss,
  tableCsv,
  taxSummary,
  type BusinessDto,
  type Comparison,
  type DateRange,
  type RangePreset,
  type ReportTable,
} from '@lse/shared';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAccess } from '../../api/hooks';
import { useBusiness } from '../../api/business';
import { IconBusiness, IconPrint } from '../../components/icons';
import { Button, EmptyState, ListSkeleton, Page } from '../../components/ui';
import { BudgetSheet } from './BudgetSheet';
import { money, saveFile, shortDate } from './format';
import { REPORTS, type ReportKind } from './reportsList';

const AS_AT: ReportKind[] = ['balance-sheet', 'aged-receivables', 'aged-payables'];
const COMPARES: ReportKind[] = ['profit-and-loss', 'balance-sheet'];

function build(
  kind: ReportKind,
  d: BusinessDto,
  range: DateRange,
  asAt: string,
  cmp: Comparison,
  account: string,
): ReportTable {
  switch (kind) {
    case 'profit-and-loss':
      return profitAndLoss(d, range, cmp === 'none' ? [] : [compareRange(range, cmp)]);
    case 'balance-sheet': {
      const other = cmp === 'none' ? [] : [compareRange({ from: asAt, to: asAt }, cmp).to];
      return balanceSheet(d, asAt, d.yearStart, other);
    }
    case 'aged-receivables':
      return aged(d, 'receivables', asAt);
    case 'aged-payables':
      return aged(d, 'payables', asAt);
    case 'cash-flow':
      return cashFlow(d, range);
    case 'tax':
      return taxSummary(d, range);
    case 'budget':
      return budgetVsActual(d, range);
    case 'transactions':
      return accountTransactions(d, account, range);
  }
}

/** One Xero-style report with its period, comparison, CSV export and print (or save as PDF). */
export function ReportScreen() {
  const { kind = 'profit-and-loss' } = useParams<{ kind: ReportKind }>();
  const [params, setParams] = useSearchParams();
  const access = useAccess();
  const b = useBusiness();
  const meta = REPORTS.find((r) => r.kind === kind) ?? REPORTS[0]!;
  const today = b.data?.today ?? '';
  const preset =
    (params.get('range') as RangePreset | 'custom' | null) ??
    (kind === 'cash-flow' || kind === 'budget' ? 'this_year' : 'year_to_date');
  const cmp = (params.get('compare') as Comparison | null) ?? 'none';
  const account = params.get('account') ?? '090';
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    p.set(k, v);
    setParams(p, { replace: true });
  };
  const [budget, setBudget] = useState(false);

  const range: DateRange | null = !b.data
    ? null
    : preset === 'custom'
      ? { from: params.get('from') ?? `${today.slice(0, 4)}-01-01`, to: params.get('to') ?? today }
      : presetRange(preset, today, b.data.yearStart);
  const asAt = params.get('asAt') ?? today;
  const table = useMemo(
    () =>
      b.data && range && range.from <= range.to
        ? build(meta.kind, b.data, range, asAt, cmp, account)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [b.data, meta.kind, range?.from, range?.to, asAt, cmp, account],
  );
  const back = { label: 'Business', to: '/business' };

  if (b.isError)
    return (
      <Page title={meta.title} back={back}>
        <EmptyState
          icon={<IconBusiness />}
          title="Couldn’t load the report"
          message={b.error.message}
          action={<Button onClick={() => b.refetch()}>Try again</Button>}
        />
      </Page>
    );
  if (!b.data || !range)
    return (
      <Page title={meta.title} back={back}>
        <ListSkeleton rows={8} />
      </Page>
    );

  const asAtReport = AS_AT.includes(meta.kind);
  const fileName = `lse-${meta.kind}-${asAtReport ? asAt : `${range.from}-to-${range.to}`}.csv`;
  return (
    <Page
      title={meta.title}
      back={back}
      wide
      actions={
        table && (
          <>
            {meta.kind === 'budget' && access.isAdmin && (
              <Button variant="plain" onClick={() => setBudget(true)}>
                <span className="hide-phone">Edit </span>Budget
              </Button>
            )}
            <Button variant="plain" onClick={() => void saveFile(tableCsv(table), fileName)}>
              <span className="hide-phone">Export </span>CSV
            </Button>
            <Button
              variant="plain"
              onClick={() => window.print()}
              aria-label="Print or save as PDF"
            >
              <IconPrint width={20} height={20} /> PDF
            </Button>
          </>
        )
      }
    >
      <div className="rpt-controls" role="group" aria-label="Report options">
        {asAtReport ? (
          <label className="rpt-control">
            <span>As at</span>
            <input
              type="date"
              value={asAt}
              max="2100-12-31"
              onChange={(e) => e.target.value && set('asAt', e.target.value)}
            />
          </label>
        ) : (
          <>
            <label className="rpt-control">
              <span>Period</span>
              <select value={preset} onChange={(e) => set('range', e.target.value)}>
                {(Object.keys(RANGE_LABEL) as RangePreset[]).map((p) => (
                  <option key={p} value={p}>
                    {RANGE_LABEL[p]}
                  </option>
                ))}
                <option value="custom">Custom dates</option>
              </select>
            </label>
            {preset === 'custom' && (
              <>
                <label className="rpt-control">
                  <span>From</span>
                  <input
                    type="date"
                    value={range.from}
                    onChange={(e) => e.target.value && set('from', e.target.value)}
                  />
                </label>
                <label className="rpt-control">
                  <span>To</span>
                  <input
                    type="date"
                    value={range.to}
                    onChange={(e) => e.target.value && set('to', e.target.value)}
                  />
                </label>
              </>
            )}
          </>
        )}
        {COMPARES.includes(meta.kind) && (
          <label className="rpt-control">
            <span>Compare with</span>
            <select value={cmp} onChange={(e) => set('compare', e.target.value)}>
              {(Object.keys(COMPARISON_LABEL) as Comparison[]).map((c) => (
                <option key={c} value={c}>
                  {COMPARISON_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
        )}
        {meta.kind === 'transactions' && (
          <label className="rpt-control">
            <span>Account</span>
            <select value={account} onChange={(e) => set('account', e.target.value)}>
              {ACCOUNTS.filter((a) => a.code !== '960').map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!table ? (
        <p className="biz-bad" role="alert">
          The start date must be on or before the end date.
        </p>
      ) : (
        <ReportView table={table} range={range} preset={preset} />
      )}
      {meta.kind === 'budget' && (
        <BudgetSheet
          open={budget}
          onClose={() => setBudget(false)}
          data={b.data}
          year={Number(range.from.slice(0, 4))}
        />
      )}
    </Page>
  );
}

function ReportView({
  table,
  range,
  preset,
}: {
  table: ReportTable;
  range: DateRange;
  preset: string;
}) {
  const fmt = (v: number | null, i: number) => {
    if (v === null) return '';
    const f = table.formats?.[i] ?? 'money';
    if (f === 'percent') return `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v / 100).toFixed(1)}%`;
    if (f === 'count') return String(v);
    return money(v);
  };
  const cols = table.columns;
  const textCols = table.textColumns ?? [];
  const accountLink = (code: string) => {
    const p = new URLSearchParams({ account: code, range: preset });
    if (preset === 'custom') {
      p.set('from', range.from);
      p.set('to', range.to);
    }
    return `/business/reports/transactions?${p}`;
  };
  return (
    <section className="rpt" aria-label={table.title}>
      <header className="rpt__head">
        <p className="rpt__biz">Little Sark Electric</p>
        <h2>{table.title}</h2>
        <p>{table.subtitle}</p>
      </header>
      <div className="rpt__scroll">
        <table className="rpt__table">
          <thead>
            <tr>
              <th scope="col" className="rpt__label">
                <span className="visually-hidden">Item</span>
              </th>
              {textCols.map((c) => (
                <th key={c} scope="col" className="rpt__text">
                  {c}
                </th>
              ))}
              {cols.map((c, i) => (
                <th key={`${c}-${i}`} scope="col" className="rpt__num">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, n) =>
              r.kind === 'section' ? (
                <tr key={n} className="rpt__section">
                  <th scope="rowgroup" colSpan={1 + textCols.length + cols.length}>
                    {r.label}
                  </th>
                </tr>
              ) : r.kind === 'note' ? (
                <tr key={n} className="rpt__note">
                  <td colSpan={1 + textCols.length + cols.length}>{r.label}</td>
                </tr>
              ) : (
                <tr key={n} className={`rpt__${r.kind}`}>
                  <th scope="row" className="rpt__label">
                    {r.account && r.kind === 'line' ? (
                      <Link to={accountLink(r.account)}>{r.label}</Link>
                    ) : (
                      r.label
                    )}
                  </th>
                  {textCols.map((_, i) => (
                    <td key={i} className="rpt__text">
                      {r.text?.[i] ?? ''}
                    </td>
                  ))}
                  {cols.map((_, i) => {
                    const v = r.values[i] ?? null;
                    return (
                      <td key={i} className={`rpt__num${v !== null && v < 0 ? ' rpt__neg' : ''}`}>
                        {fmt(v, i)}
                      </td>
                    );
                  })}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {table.notes?.length ? (
        <ul className="rpt__notes">
          {table.notes.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      <p className="rpt__printed">
        Printed {shortDate(new Date().toISOString().slice(0, 10))} from LSE Trade
      </p>
    </section>
  );
}
