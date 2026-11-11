import { JOB_STATUS } from '../lib/status';
import { getOutbox, useSync } from '../offline';
import type { OutboxOp } from '../offline/outbox';
import { Button, EmptyState, List, Page, Section, StaticRow } from '../components/ui';
import { IconCheckCircle } from '../components/icons';
import { formatDateTime } from './syncFormat';

const FIELD_LABEL: Record<string, string> = {
  status: 'Status',
  title: 'Title',
  description: 'Description',
  notes: 'Notes',
  lines: 'Lines',
  siteId: 'Site',
  placeOfWork: 'Place of work',
  validDays: 'Valid for',
};

const show = (field: string, v: unknown) => {
  if (field === 'status' && typeof v === 'string' && v in JOB_STATUS)
    return JOB_STATUS[v as keyof typeof JOB_STATUS].label;
  if (field === 'lines' && Array.isArray(v)) return `${v.length} line${v.length === 1 ? '' : 's'}`;
  if (v == null || v === '') return '—';
  return String(v);
};

/** Everything not yet on the server, and anything that needs a decision. */
export function SyncScreen() {
  const sync = useSync();
  return (
    <Page title="Sync" back={{ label: 'Back' }}>
      {sync.ops.length === 0 ? (
        <EmptyState
          icon={<IconCheckCircle />}
          title="Everything is synced"
          message="All your changes are saved on the server."
        />
      ) : (
        <>
          {sync.ops
            .filter((o) => o.status !== 'pending')
            .map((op) => (
              <ProblemCard key={op.id} op={op} />
            ))}
          {sync.pending > 0 && (
            <Section
              header="Waiting to sync"
              footer="Saved on this device. They’ll be sent automatically when there’s signal."
            >
              <List>
                {sync.ops
                  .filter((o) => o.status === 'pending')
                  .map((op) => (
                    <li key={op.id}>
                      <StaticRow>
                        <span className="row__main">
                          <span className="row__title">{op.label}</span>
                          <span className="row__sub">
                            {Object.keys(op.changes)
                              .map((k) => FIELD_LABEL[k] ?? k)
                              .join(', ')}{' '}
                            · {formatDateTime(op.updatedAt)}
                          </span>
                        </span>
                      </StaticRow>
                    </li>
                  ))}
              </List>
              <Button
                variant="secondary"
                block
                loading={sync.syncing}
                onClick={() => void getOutbox().flush()}
              >
                Try now
              </Button>
            </Section>
          )}
        </>
      )}
    </Page>
  );
}

function ProblemCard({ op }: { op: OutboxOp }) {
  const box = getOutbox();
  if (op.status === 'conflict' && op.conflict) {
    return (
      <Section
        header={`${op.label}: changed on another device`}
        footer="Pick which version to keep. Nothing is lost until you choose."
      >
        <List>
          {op.conflict.fields.map((f) => (
            <li key={f}>
              <StaticRow>
                <span className="row__main">
                  <span className="row__title">{FIELD_LABEL[f] ?? f}</span>
                  <span className="row__sub">
                    Yours: {show(f, op.changes[f])} · Other device:{' '}
                    {show(f, op.conflict!.server[f])}
                  </span>
                </span>
              </StaticRow>
            </li>
          ))}
        </List>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button block onClick={() => void box.keepMine(op.id)}>
            Keep mine
          </Button>
          <Button block variant="secondary" onClick={() => void box.discard(op.id)}>
            Use theirs
          </Button>
        </div>
      </Section>
    );
  }
  return (
    <Section header={`${op.label}: couldn’t save`} footer={op.error}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button block variant="secondary" onClick={() => void box.retry(op.id)}>
          Try again
        </Button>
        <Button block variant="destructive" onClick={() => void box.discard(op.id)}>
          Discard my change
        </Button>
      </div>
    </Section>
  );
}
