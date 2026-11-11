import type { JobStageDto, JobSummaryDto, SystemStageKey } from '@lse/shared';
import { useState } from 'react';
import { useJobs, useJobStages } from '../api/hooks';
import {
  IconCheck,
  IconJobs,
  IconMore,
  IconPause,
  IconPlus,
  IconQuotes,
} from '../components/icons';
import { StagePill, StageSheet, useChangeStage } from '../components/Stage';
import { SwipeRow, type SwipeAction } from '../components/SwipeRow';
import {
  Button,
  EmptyState,
  IconButton,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  SearchField,
  Section,
  Segmented,
} from '../components/ui';
import { useDebounced } from '../lib/useDebounced';
import { NewJobSheet } from './sheets/NewJobSheet';

export function JobsScreen() {
  // 'active', 'all', or a stage id
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [pickingFilter, setPickingFilter] = useState(false);
  const [moving, setMoving] = useState<JobSummaryDto | null>(null);
  const q = useDebounced(search.trim());
  const jobs = useJobs(filter, q);
  const stages = useJobStages();
  const { change, pendingId } = useChangeStage();
  const items = jobs.data?.items ?? [];
  const byKey = (k: SystemStageKey) => stages.data?.find((s) => s.systemKey === k);
  const filterStage = stages.data?.find((s) => s.id === filter);
  const isStageFilter = filter !== 'active' && filter !== 'all';

  /** Quick actions on a swipe: the next usual step, a pause, and every stage. */
  const swipeActions = (j: JobSummaryDto): SwipeAction[] => {
    const quick: {
      stage: JobStageDto | undefined;
      label: string;
      tone: SwipeAction['tone'];
      icon: React.ReactNode;
    }[] = j.stage.isActive
      ? [
          j.stage.systemKey === 'to_invoice'
            ? { stage: byKey('complete'), label: 'Complete', tone: 'green', icon: <IconCheck /> }
            : {
                stage: byKey('to_invoice'),
                label: 'To Invoice',
                tone: 'purple',
                icon: <IconQuotes />,
              },
          ...(j.stage.systemKey === 'on_hold'
            ? []
            : [
                {
                  stage: byKey('on_hold'),
                  label: 'On Hold',
                  tone: 'yellow' as const,
                  icon: <IconPause />,
                },
              ]),
        ]
      : [];
    return [
      ...quick
        .filter((a) => a.stage)
        .map((a) => ({
          label: a.stage!.name,
          tone: a.tone,
          icon: a.icon,
          onAction: () => change(j, a.stage!),
        })),
      { label: 'Stage', tone: 'grey', icon: <IconMore />, onAction: () => setMoving(j) },
    ];
  };

  return (
    <Page
      title="Jobs"
      actions={
        <IconButton label="New job" onClick={() => setAdding(true)}>
          <IconPlus />
        </IconButton>
      }
    >
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder="Search jobs, customers or sites"
      />
      <Segmented
        label="Filter jobs"
        value={isStageFilter ? 'stage' : filter}
        onChange={(v) => (v === 'stage' ? setPickingFilter(true) : setFilter(v))}
        options={[
          { value: 'active', label: 'Active' },
          { value: 'all', label: 'All' },
          { value: 'stage', label: filterStage ? filterStage.name : 'Stage…' },
        ]}
      />
      {jobs.isPending ? (
        <ListSkeleton />
      ) : jobs.isError ? (
        <EmptyState
          icon={<IconJobs />}
          title="Couldn’t load jobs"
          message={jobs.error.message}
          action={<Button onClick={() => jobs.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconJobs />}
          title={
            q
              ? 'No matches'
              : filter === 'active'
                ? 'All clear'
                : isStageFilter
                  ? 'None here'
                  : 'No jobs yet'
          }
          message={
            q
              ? `No job matches “${q}”.`
              : filter === 'active'
                ? 'No active jobs. Accepted quotes become jobs in one tap.'
                : isStageFilter
                  ? `No jobs are in ${filterStage?.name ?? 'this stage'}.`
                  : 'Create a job for a call-out, or from an accepted quote.'
          }
          action={
            !q && !isStageFilter ? (
              <Button onClick={() => setAdding(true)}>New job</Button>
            ) : undefined
          }
        />
      ) : (
        <Section
          footer={
            <>
              {jobs.data.total} {jobs.data.total === 1 ? 'job' : 'jobs'}
              <span className="touch-only"> · Swipe left on a job to change its stage</span>
            </>
          }
        >
          <List label="Jobs">
            {items.map((j) => (
              <li key={j.id}>
                <SwipeRow actions={swipeActions(j)}>
                  <LinkRow
                    to={`/jobs/${j.id}`}
                    lead={
                      <span
                        className="row__lead num"
                        aria-hidden
                        style={{ width: 'auto', minWidth: 44, padding: '0 8px' }}
                      >
                        {j.number}
                      </span>
                    }
                    title={j.title}
                    sub={[j.customerName, j.siteAddress].filter(Boolean).join(' · ')}
                    meta={
                      pendingId === j.id ? (
                        <Pill tone="orange">Saving…</Pill>
                      ) : (
                        <StagePill stage={j.stage} />
                      )
                    }
                  />
                </SwipeRow>
              </li>
            ))}
          </List>
        </Section>
      )}
      <NewJobSheet open={adding} onClose={() => setAdding(false)} />
      <StageSheet
        open={pickingFilter}
        title="Show stage"
        currentId={isStageFilter ? filter : undefined}
        onPick={(s) => setFilter(s.id)}
        onClose={() => setPickingFilter(false)}
      />
      <StageSheet
        open={!!moving}
        title={moving ? `Move job ${moving.number}` : ''}
        currentId={moving?.stage.id}
        onPick={(s) => moving && change(moving, s)}
        onClose={() => setMoving(null)}
      />
    </Page>
  );
}
