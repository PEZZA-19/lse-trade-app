import {
  formatMinutes,
  formatPence,
  marginBp,
  reportPeriodRange,
  reportsCsv,
  type JobProfitDto,
  type ReportPeriod,
} from '@lse/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMe, useSettings } from '../../api/hooks';
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

const iso = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Guernsey' }).format(d);
const shortDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const PERIOD_LABEL: Record<ReportPeriod, string> = {
  month: 'this month',
  last: 'last month',
  year: 'this year',
};
const signed = (p: number) => `${p < 0 ? '−' : ''}${formatPence(Math.abs(p))}`;

/** Expected profit for the whole job (the honest headline), with its margin. */
function Profit({ j }: { j: JobProfitDto }) {
  const bp = marginBp(j.expectedProfitPence, j.revenuePence);
  return (
    <span
      className="report-profit"
      style={{ color: j.expectedProfitPence < 0 ? 'var(--red)' : 'var(--green)' }}
    >
      <span>
        {signed(j.expectedProfitPence)}
        {bp !== null && <small> {Math.round(bp / 100)}%</small>}
      </span>
      <small className="report-profit__label">expected</small>
    </span>
  );
}

/** Saves the CSV: the share sheet on phones that support files, else a download. */
async function exportCsv(csv: string, name: string) {
  const file = new File([csv], name, { type: 'text/csv' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: name }).catch(() => undefined);
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Owner reports under More: money in and owed, true profit per job (revenue − labour at each
 * person's cost rate − materials at cost) and time by person and job. Read-only.
 */
export function ReportsScreen() {
  const me = useMe();
  const settings = useSettings();
  const owner = me.data?.role === 'owner';
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const year = settings.data ?? { yearStart: '01-01', yearEffectiveFrom: '2027-01-01' };
  const { from, to } = reportPeriodRange(period, iso(new Date()), year);
  const r = useReports(from, to, owner && !!settings.data);
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
  const missing = d ? d.costRates.people - d.costRates.set : 0;
  return (
    <Page
      title="Reports"
      back={back}
      actions={
        d && (
          <Button
            variant="plain"
            onClick={() => void exportCsv(reportsCsv(d), `lse-reports-${d.from}-to-${d.to}.csv`)}
          >
            Export CSV
          </Button>
        )
      }
    >
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
      <p className="report-range" aria-live="polite">
        {shortDate(from)} – {shortDate(to)}
      </p>
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
            footer={`Expected profit = the quote (ex VAT) − expected costs: quoted labour and materials at cost, or what has already been spent if that is more. So far = invoiced (ex VAT, less credit notes) − labour at each person’s cost rate − materials at cost, so a job in progress never counts its whole quote. A job without a quote expects its lines plus time at each person’s charge-out rate (${rate}/h unless set in Settings › Team). Whole jobs, not just this period.`}
          >
            {missing > 0 && (
              <p className="readiness" role="note">
                {missing === 1 ? '1 person has' : `${missing} people have`} no cost rate, so their
                time is costed at their charge-out rate.{' '}
                <Link to="/settings">Set cost rates in Settings › Team</Link>
              </p>
            )}
            {d.jobs.length ? (
              <List className="report-list" label="Profit per job">
                {d.jobs.map((j) => (
                  <li key={j.jobId}>
                    <LinkRow
                      to={`/jobs/${j.jobId}`}
                      title={`${j.number} · ${j.title}`}
                      sub={`${j.quotedPence === null ? 'Not quoted, expected' : 'Quote'} ${formatPence(j.revenuePence)} · invoiced ${formatPence(j.invoicedPence)} · so far ${signed(j.profitPence)} · ${formatMinutes(j.minutes)}: ${formatPence(j.labourPence)} at cost, ${formatPence(j.chargeOutPence)} charge-out · materials ${formatPence(j.materialsCostPence)}`}
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
              <List className="report-list" label="Time by job">
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
