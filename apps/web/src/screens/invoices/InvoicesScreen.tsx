import { formatPence } from '@lse/shared';
import { useState } from 'react';
import { useInvoices, type InvoiceFilter } from '../../api/billing';
import { IconQuotes } from '../../components/icons';
import {
  Button,
  EmptyState,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  Segmented,
} from '../../components/ui';
import { INVOICE_STATUS, dueLabel } from '../../lib/status';

const FILTERS: { value: InvoiceFilter; label: string }[] = [
  { value: 'outstanding', label: 'Unpaid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'draft', label: 'Drafts' },
  { value: 'paid', label: 'Paid' },
  { value: 'all', label: 'All' },
];

const EMPTY: Record<InvoiceFilter, string> = {
  outstanding: 'Nothing waiting to be paid.',
  overdue: 'No overdue invoices. Nice.',
  draft: 'No drafts. Create an invoice from a job.',
  paid: 'No paid invoices yet.',
  all: 'Invoices are created from a job: open the job and tap New Invoice.',
};

/** Under More: every invoice, with the overdue list one tap away. */
export function InvoicesScreen() {
  const [filter, setFilter] = useState<InvoiceFilter>('outstanding');
  const list = useInvoices(filter);
  const items = list.data ?? [];
  const owed = items.reduce((a, i) => a + (i.status === 'draft' ? 0 : i.balancePence), 0);
  return (
    <Page title="Invoices" back={{ label: 'More', to: '/more' }}>
      <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <EmptyState
          icon={<IconQuotes />}
          title="Couldn’t load invoices"
          message={list.error.message}
          action={<Button onClick={() => list.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState icon={<IconQuotes />} title="No invoices" message={EMPTY[filter]} />
      ) : (
        <Section
          footer={
            filter === 'outstanding' || filter === 'overdue'
              ? `${items.length} ${items.length === 1 ? 'invoice' : 'invoices'} · ${formatPence(owed)} owed`
              : `${items.length} ${items.length === 1 ? 'invoice' : 'invoices'}`
          }
        >
          <List label="Invoices">
            {items.map((i) => {
              const st = INVOICE_STATUS[i.displayStatus];
              return (
                <li key={i.id}>
                  <LinkRow
                    to={`/invoices/${i.id}`}
                    title={
                      <>
                        {i.number ? `Invoice ${i.number}` : `Draft · job ${i.jobNumber}`}
                        <span style={{ color: 'var(--label-2)', fontWeight: 400 }}>
                          {' '}
                          · {i.customerName}
                        </span>
                      </>
                    }
                    sub={
                      <>
                        <Pill tone={st.tone}>{st.label}</Pill> {i.jobTitle} · {dueLabel(i)}
                      </>
                    }
                    meta={
                      <span className="num" style={{ textAlign: 'right' }}>
                        {formatPence(
                          i.status === 'paid' || i.status === 'draft'
                            ? i.totalPence
                            : i.balancePence,
                        )}
                        {i.status === 'part_paid' && (
                          <span className="row__sub" style={{ display: 'block' }}>
                            of {formatPence(i.totalPence)}
                          </span>
                        )}
                      </span>
                    }
                  />
                </li>
              );
            })}
          </List>
        </Section>
      )}
    </Page>
  );
}
