import { formatPence, formatQty, JOB_STATUSES, type JobStatus } from '@lse/shared';
import { useParams } from 'react-router';
import { useJob, useSetJobStatus } from '../api/hooks';
import { NeedsAttentionError } from '../offline';
import { IconJobs, IconQuotes } from '../components/icons';
import { useToast } from '../components/Toast';
import {
  Button,
  EmptyState,
  KeyValueRow,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  SelectField,
} from '../components/ui';
import { JOB_STATUS, LINE_KIND_LABEL } from '../lib/status';

const PLACE = { sark: 'Sark', guernsey: 'Guernsey', other: 'Elsewhere' } as const;

export function JobScreen() {
  const { id = '' } = useParams();
  const job = useJob(id);
  const setStatus = useSetJobStatus();
  const toast = useToast();

  if (job.isPending)
    return (
      <Page title="" back={{ label: 'Jobs', to: '/jobs' }}>
        <ListSkeleton rows={3} />
      </Page>
    );
  if (job.isError)
    return (
      <Page title="Job" back={{ label: 'Jobs', to: '/jobs' }}>
        <EmptyState
          icon={<IconJobs />}
          title="Couldn’t load this job"
          message={job.error.message}
          action={<Button onClick={() => job.refetch()}>Try again</Button>}
        />
      </Page>
    );
  const j = job.data;
  const pending = setStatus.isPending ? setStatus.variables?.status : undefined;

  return (
    <Page title={`Job ${j.number}`} subtitle={j.title} back={{ label: 'Jobs', to: '/jobs' }}>
      <div className="hero">
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
        >
          <Pill tone={JOB_STATUS[j.status].tone}>{JOB_STATUS[j.status].label}</Pill>
          {pending && <span className="save-status save-status--pending">Saving…</span>}
        </div>
        <div className="hero__meta">
          {[j.customerName, j.site?.address, PLACE[j.placeOfWork]].filter(Boolean).join(' · ')}
        </div>
      </div>

      <Section header="Status">
        <List className="form-list">
          <SelectField
            label="Status"
            value={pending ?? j.status}
            disabled={!!pending}
            onChange={(e) =>
              setStatus.mutate(
                { id: j.id, status: e.target.value as JobStatus },
                {
                  onSuccess: (r) => {
                    if (r === 'queued')
                      toast.show('Saved on this device. It will sync when you’re back online.');
                  },
                  onError: (err) =>
                    toast.show(
                      err instanceof NeedsAttentionError
                        ? err.message
                        : `Status not changed. ${err.message}`,
                      { tone: 'error' },
                    ),
                },
              )
            }
          >
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {JOB_STATUS[s].label}
              </option>
            ))}
          </SelectField>
        </List>
      </Section>

      <Section header="Customer">
        <List>
          <li>
            <LinkRow
              to={`/customers/${j.customerId}`}
              title={j.customerName}
              sub={
                j.site
                  ? j.site.label
                    ? `${j.site.label}: ${j.site.address}`
                    : j.site.address
                  : 'No site'
              }
            />
          </li>
          {j.sourceQuoteId && (
            <li>
              <LinkRow
                to={`/quotes/${j.sourceQuoteId}`}
                lead={<IconQuotes width={22} height={22} color="var(--accent)" />}
                title={`From quote ${j.sourceQuoteNumber}${j.sourceQuoteRevision && j.sourceQuoteRevision > 1 ? ` rev ${String.fromCharCode(64 + j.sourceQuoteRevision)}` : ''}`}
                sub="What was quoted is kept below as the plan"
              />
            </li>
          )}
        </List>
      </Section>

      {j.description && (
        <Section header="Notes">
          <List>
            <li>
              <div className="row" style={{ whiteSpace: 'pre-wrap' }}>
                {j.description}
              </div>
            </li>
          </List>
        </Section>
      )}

      {j.lines.length > 0 && (
        <Section
          header="Quoted work"
          footer="Time and materials logged against the job come in a later update."
        >
          <List>
            {j.lines.map((l) => (
              <li key={l.id}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">{l.description}</span>
                    <span className="row__sub">
                      {LINE_KIND_LABEL[l.kind]} · {formatQty(l.qtyMilli)} ×{' '}
                      {formatPence(l.unitSellPence)}
                    </span>
                  </span>
                  <span className="row__meta num" style={{ color: 'var(--label)' }}>
                    {formatPence(l.totalPence)}
                  </span>
                </div>
              </li>
            ))}
            <li>
              <KeyValueRow label="Quoted total" value={formatPence(j.quotedTotalPence)} strong />
            </li>
          </List>
        </Section>
      )}
    </Page>
  );
}
