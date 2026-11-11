import { formatPence, formatQty, STAGE_CAUSE_LABEL } from '@lse/shared';
import { useParams } from 'react-router';
import { useJob, useJobStages } from '../api/hooks';
import { StageDot, StagePill, useChangeStage } from '../components/Stage';
import { formatDateTime } from './syncFormat';
import { IconJobs, IconQuotes } from '../components/icons';
import {
  Button,
  EmptyState,
  KeyValueRow,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Section,
  SelectField,
  StaticRow,
} from '../components/ui';
import { LINE_KIND_LABEL } from '../lib/status';

const PLACE = { sark: 'Sark', guernsey: 'Guernsey', other: 'Elsewhere' } as const;

export function JobScreen() {
  const { id = '' } = useParams();
  const job = useJob(id);
  const stages = useJobStages();
  const { change, pendingId, set } = useChangeStage();

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
  const pending = pendingId === j.id ? set.variables?.stage : undefined;
  // The job's own stage is always listed, even before the stage list has loaded.
  const options = stages.data?.some((s) => s.id === j.stage.id)
    ? stages.data
    : [j.stage, ...(stages.data ?? [])];

  return (
    <Page title={`Job ${j.number}`} subtitle={j.title} back={{ label: 'Jobs', to: '/jobs' }}>
      <div className="hero">
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
        >
          <StagePill stage={pending ?? j.stage} />
          {pending && <span className="save-status save-status--pending">Saving…</span>}
        </div>
        <div className="hero__meta">
          {[j.customerName, j.site?.address, PLACE[j.placeOfWork]].filter(Boolean).join(' · ')}
        </div>
      </div>

      <Section header="Stage">
        <List className="form-list">
          <SelectField
            label="Stage"
            value={pending?.id ?? j.stage.id}
            disabled={!!pending}
            onChange={(e) => {
              const to = options.find((s) => s.id === e.target.value);
              if (to) change(j, to);
            }}
          >
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
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

      {j.history.length > 0 && (
        <Section header="History" footer="Every stage change, automatic or by hand.">
          <List label="Stage history">
            {[...j.history].reverse().map((h) => (
              <li key={h.id}>
                <StaticRow>
                  <StageDot colour={h.toColour} />
                  <span className="row__main">
                    <span className="row__title">
                      {h.fromName ? `${h.fromName} → ${h.toName}` : h.toName}
                    </span>
                    <span className="row__sub">
                      {[STAGE_CAUSE_LABEL[h.cause], h.userName, formatDateTime(h.createdAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </StaticRow>
              </li>
            ))}
          </List>
        </Section>
      )}
    </Page>
  );
}
