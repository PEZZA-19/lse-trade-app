import { formatMinutes, formatPence, marginBp, type JobProfitDto } from '@lse/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMe } from '../../api/hooks';
import { useReports } from '../../api/reports';
import { IconChart } from '../../components/icons';
import {
  Button,
  EmptyState,
  KeyValueRow,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Section,
  Segmented,
} from '../../components/ui';

type Period = 'month' | 'last' | 'year';

const iso = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(d);

/** Calendar periods in the business's own time zone, ending today at the latest. */
export function periodRange(p: Period, now = new Date()): { from: string; to: string } {
  const today = iso(now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  if (p === 'year') return { from: `${y}-01-01`, to: today };
  if (p === 'month') return { from: `${y}-${pad(m)}-01`, to: today };
  const ly = m === 1 ? y - 1 : y;
  const lm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
  return { from: `${ly}-${pad(lm)}-01`, to: `${ly}-${pad(lm)}-${pad(last)}` };
}

const PERIOD_LABEL: Record<Period, string> = {
  month: 'this month',
  last: 'last month',
  year: 'this year',
};

function Profit({ j }: { j: JobProfitDto }) {
  const bp = marginBp(j);
  return (
    <span
      className="report-profit"
      style={{ color: j.profitPence < 0 ? 'var(--red)' : 'var(--green)' }}
    >
      {j.profitPence < 0 ? '−' : ''}
      {formatPence(Math.abs(j.profitPence))}
      {bp !== null && <small> {Math.round(bp / 100)}%</small>}
    </span>
  );
}

/**
 * Owner reports under More: money in and owed, profit per job (price against actual time and
 * materials) and time by person and job. Read-only; every figure links back to its records.
 */
export function ReportsScreen() {
  const me = useMe();
  const owner = me.data?.role === 'owner';
  const [period, setPeriod] = useState<Period>('month');
  const { from, to } = periodRange(period);
  const r = useReports(from, to, owner);
  const back = { label: 'More', to: '/more' };

  if (me.data && !owner)
    return (
      <Page title="Reports" back={back}>
        <EmptyState
          icon={<IconChart />}
          title="Only the owner sees reports"
          message="Reports show the business’s money, so they’re kept to the owner."
        />
      </Page>
    );

  const d = r.data;
  const rate = d ? formatPence(d.labourRatePence) : '';
  return (
    <Page title="Reports" back={back}>
      <Segmented
        label="Period"
        value={period}
        onChange={setPeriod}
        options={[
          { value: 'month', label: 'This Month' },
          { value: 'last', label: 'Last Month' },
          { value: 'year', label: 'This Year' },
        ]}
      />
      {r.isError ? (
        <EmptyState
          icon={<IconChart />}
          title="Couldn’t load the reports"
          message={r.error.message}
          action={<Button onClick={() => r.refetch()}>Try again</Button>}
        />
      ) : !d ? (
        <ListSkeleton rows={6} />
      ) : (
        <>
          <Section
            header="Money"
            footer={`In and invoiced are for ${PERIOD_LABEL[period]}. Owed is right now, whatever the period.`}
          >
            <List className="form-list" label="Money">
              <KeyValueRow
                label={`Money in (${d.money.paymentCount} payment${d.money.paymentCount === 1 ? '' : 's'})`}
                value={formatPence(d.money.inPence)}
                strong
              />
              <KeyValueRow
                label="Invoiced, less credit notes"
                value={formatPence(d.money.invoicedPence)}
              />
              <KeyValueRow label="Supplier bills applied" value={formatPence(d.money.billsPence)} />
              <KeyValueRow
                label={
                  <Link to="/invoices">
                    Owed now ({d.money.owedCount} invoice{d.money.owedCount === 1 ? '' : 's'})
                  </Link>
                }
                value={formatPence(d.money.owedPence)}
                strong
              />
              <KeyValueRow
                label={`Overdue (${d.money.overdueCount})`}
                value={
                  <span style={d.money.overduePence ? { color: 'var(--red)' } : undefined}>
                    {formatPence(d.money.overduePence)}
                  </span>
                }
              />
            </List>
          </Section>

          <Section
            header="Profit per Job"
            footer={`Price is the accepted quote (ex VAT), or the job’s lines when it wasn’t quoted. Time is valued at your ${rate}/h labour rate and materials at what you paid. Whole jobs, not just this period.`}
          >
            {d.jobs.length ? (
              <List label="Profit per job">
                {d.jobs.map((j) => (
                  <li key={j.jobId}>
                    <LinkRow
                      to={`/jobs/${j.jobId}`}
                      title={`${j.number} · ${j.title}`}
                      sub={`${j.quotedPence !== null ? `Quoted ${formatPence(j.quotedPence)}` : `Not quoted · lines ${formatPence(j.lineValuePence)}`} · time ${formatMinutes(j.minutes)} (${formatPence(j.labourPence)}) · materials ${formatPence(j.materialsCostPence)}`}
                      meta={<Profit j={j} />}
                    />
                  </li>
                ))}
              </List>
            ) : (
              <p className="sheet-hint">No jobs with a quote, time or materials yet.</p>
            )}
          </Section>

          <Section
            header="Time by Person"
            footer={`${formatMinutes(d.time.totalMinutes)} logged ${PERIOD_LABEL[period]}.`}
          >
            {d.time.byPerson.length ? (
              <List className="form-list" label="Time by person">
                {d.time.byPerson.map((p) => (
                  <KeyValueRow key={p.id} label={p.name} value={formatMinutes(p.minutes)} />
                ))}
              </List>
            ) : (
              <p className="sheet-hint">No time logged {PERIOD_LABEL[period]}.</p>
            )}
          </Section>

          {d.time.byJob.length > 0 && (
            <Section header="Time by Job">
              <List label="Time by job">
                {d.time.byJob.map((j) => (
                  <li key={j.id}>
                    <LinkRow
                      to={`/jobs/${j.id}`}
                      title={`${j.number} · ${j.name}`}
                      sub={j.byPerson
                        .map((p) => `${p.name} ${formatMinutes(p.minutes)}`)
                        .join(' · ')}
                      meta={formatMinutes(j.minutes)}
                    />
                  </li>
                ))}
              </List>
            </Section>
          )}
        </>
      )}
    </Page>
  );
}
