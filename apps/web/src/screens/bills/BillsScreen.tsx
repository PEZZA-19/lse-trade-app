import { formatPence } from '@lse/shared';
import { useState } from 'react';
import { useBills, type BillFilter } from '../../api/bills';
import { IconPlus, IconReceipt } from '../../components/icons';
import {
  Button,
  EmptyState,
  IconButton,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  Segmented,
} from '../../components/ui';
import { shortDate } from '../../lib/status';
import { NewBillSheet } from './NewBillSheet';
import { StatementPicker } from './StatementScreen';

const FILTERS: { value: BillFilter; label: string }[] = [
  { value: 'draft', label: 'To Check' },
  { value: 'applied', label: 'Applied' },
  { value: 'all', label: 'All' },
];

/** Supplier bills and credit notes: enter, match to the price list, then apply. */
export function BillsScreen() {
  const [filter, setFilter] = useState<BillFilter>('draft');
  const [adding, setAdding] = useState(false);
  const list = useBills(filter);
  const items = list.data ?? [];
  return (
    <Page
      title="Supplier Bills"
      back={{ label: 'More', to: '/more' }}
      actions={
        <IconButton label="New bill" onClick={() => setAdding(true)}>
          <IconPlus />
        </IconButton>
      }
    >
      <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <EmptyState
          icon={<IconReceipt />}
          title="Couldn’t load bills"
          message={list.error.message}
          action={<Button onClick={() => list.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconReceipt />}
          title={filter === 'draft' ? 'Nothing to check' : 'No bills'}
          message="Enter a supplier bill by hand, from a CSV, or straight from its PDF."
          action={<Button onClick={() => setAdding(true)}>New Bill</Button>}
        />
      ) : (
        <Section footer={`${items.length} ${items.length === 1 ? 'bill' : 'bills'}`}>
          <List label="Supplier bills">
            {items.map((b) => (
              <li key={b.id}>
                <LinkRow
                  to={`/bills/${b.id}`}
                  title={
                    <>
                      {b.supplierName}
                      <span style={{ color: 'var(--label-2)', fontWeight: 400 }}>
                        {' '}
                        · {b.reference}
                      </span>
                    </>
                  }
                  sub={
                    <>
                      {b.kind === 'credit_note' && <Pill tone="purple">Credit note</Pill>}{' '}
                      {b.status === 'draft' ? (
                        <Pill tone="orange">To check</Pill>
                      ) : (
                        <Pill tone="green">Applied</Pill>
                      )}{' '}
                      {shortDate(`${b.billDate}T12:00:00Z`)}
                      {b.jobNumber ? ` · Job ${b.jobNumber}` : ''}
                      {b.status === 'draft' && b.unmatchedCount > 0
                        ? ` · ${b.unmatchedCount} not on price list`
                        : ''}
                    </>
                  }
                  meta={
                    <span className="num">
                      {b.kind === 'credit_note' ? '−' : ''}
                      {formatPence(b.totalPence)}
                    </span>
                  }
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      <Section footer="Checks a supplier statement PDF against the bills here: missing, different, and the balance due.">
        <StatementPicker />
      </Section>
      {adding && <NewBillSheet onClose={() => setAdding(false)} />}
    </Page>
  );
}
