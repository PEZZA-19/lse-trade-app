import { Link } from 'react-router';
import { useSync } from '../offline';
import { formatDateTime } from '../screens/syncFormat';
import { List, Pill, Section, StaticRow } from './ui';

type Kind = 'customer' | 'quote' | 'job';
const NOUN: Record<Kind, string> = { customer: 'customer', quote: 'quote', job: 'job' };

export const QUEUED_TOAST = (kind: Kind) =>
  `No signal: the ${NOUN[kind]} is saved on this phone and will be added when you’re back online.`;

/**
 * Customers, quotes and jobs created with no signal: saved on this device, made on the server when
 * the signal returns. They have no number or page yet, so they're listed here, honestly labelled,
 * rather than pretending to be real records.
 */
export function PendingCreates({ kind }: { kind: Kind }) {
  const sync = useSync();
  const ops = sync.ops.filter((o) => o.kind === 'action' && o.path === `/${kind}s`);
  if (!ops.length) return null;
  const failed = ops.some((o) => o.status !== 'pending');
  return (
    <Section
      header="Waiting to sync"
      footer={
        <>
          Saved on this phone.{' '}
          {kind === 'customer'
            ? 'Add quotes and jobs for them once they’ve synced.'
            : `The ${NOUN[kind]} number is given when it syncs.`}{' '}
          {failed && <Link to="/sync">Fix in Sync</Link>}
        </>
      }
    >
      <List label={`New ${NOUN[kind]}s waiting to sync`}>
        {ops.map((op) => (
          <li key={op.id}>
            <StaticRow>
              <span className="row__main">
                <span className="row__title">{op.label}</span>
                <span className="row__sub">
                  {op.status === 'pending'
                    ? `Added ${formatDateTime(op.createdAt)} · not on the server yet`
                    : `Couldn’t add: ${op.error ?? 'the server refused it'}`}
                </span>
              </span>
              <span className="row__meta">
                {op.status === 'pending' ? (
                  <Pill tone="orange">Waiting</Pill>
                ) : (
                  <Pill tone="red">Needs you</Pill>
                )}
              </span>
            </StaticRow>
          </li>
        ))}
      </List>
    </Section>
  );
}
