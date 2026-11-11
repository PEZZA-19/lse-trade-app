import { useState } from 'react';
import { useJobs, useSetJobStatus } from '../api/hooks';
import { IconCheck, IconJobs, IconPlus } from '../components/icons';
import { SwipeRow } from '../components/SwipeRow';
import { useToast } from '../components/Toast';
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
import { JOB_STATUS } from '../lib/status';
import { useDebounced } from '../lib/useDebounced';
import { NewJobSheet } from './sheets/NewJobSheet';

export function JobsScreen() {
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useDebounced(search.trim());
  const jobs = useJobs(filter, q);
  const setStatus = useSetJobStatus();
  const toast = useToast();
  const items = jobs.data?.items ?? [];
  const savingId = setStatus.isPending ? setStatus.variables?.id : undefined;

  const markDone = (id: string, number: string) =>
    setStatus.mutate(
      { id, status: 'completed' },
      {
        onSuccess: (r) =>
          toast.show(
            r === 'queued'
              ? `Job ${number} marked done on this device. It will sync when you’re back online.`
              : `Job ${number} marked done`,
          ),
        onError: (e) =>
          toast.show(`Job ${number} not updated. ${e.message}`, {
            tone: 'error',
            action: { label: 'Retry', onAction: () => markDone(id, number) },
          }),
      },
    );

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
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'active', label: 'Active' },
          { value: 'all', label: 'All' },
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
          title={q ? 'No matches' : filter === 'active' ? 'All clear' : 'No jobs yet'}
          message={
            q
              ? `No job matches “${q}”.`
              : filter === 'active'
                ? 'No active jobs. Accepted quotes become jobs in one tap.'
                : 'Create a job for a call-out, or from an accepted quote.'
          }
          action={!q ? <Button onClick={() => setAdding(true)}>New job</Button> : undefined}
        />
      ) : (
        <Section
          footer={
            <>
              {jobs.data.total} {jobs.data.total === 1 ? 'job' : 'jobs'}
              <span className="touch-only"> · Swipe left on a job to mark it done</span>
            </>
          }
        >
          <List label="Jobs">
            {items.map((j) => {
              const row = (
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
                    savingId === j.id ? (
                      <Pill tone="orange">Saving…</Pill>
                    ) : (
                      <Pill tone={JOB_STATUS[j.status].tone}>{JOB_STATUS[j.status].label}</Pill>
                    )
                  }
                />
              );
              const done = j.status === 'completed' || j.status === 'cancelled';
              return (
                <li key={j.id}>
                  {done ? (
                    row
                  ) : (
                    <SwipeRow
                      actions={[
                        {
                          label: 'Done',
                          tone: 'green',
                          icon: <IconCheck />,
                          onAction: () => markDone(j.id, j.number),
                        },
                      ]}
                    >
                      {row}
                    </SwipeRow>
                  )}
                </li>
              );
            })}
          </List>
        </Section>
      )}
      <NewJobSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}
