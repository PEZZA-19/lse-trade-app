import { useState } from 'react';
import { PendingCreates } from '../components/PendingCreates';
import { useCustomers } from '../api/hooks';
import { IconCustomers, IconMail, IconPhone, IconPlus } from '../components/icons';
import { SwipeRow, type SwipeAction } from '../components/SwipeRow';
import {
  Button,
  EmptyState,
  IconButton,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  SearchField,
  Section,
} from '../components/ui';
import { initials } from '../lib/status';
import { useDebounced } from '../lib/useDebounced';
import { NewCustomerSheet } from './sheets/NewCustomerSheet';

export function CustomersScreen() {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [adding, setAdding] = useState(false);
  const customers = useCustomers(q);
  const items = customers.data?.items ?? [];

  return (
    <Page
      title="Customers"
      actions={
        <IconButton label="Add customer" onClick={() => setAdding(true)}>
          <IconPlus />
        </IconButton>
      }
    >
      <SearchField value={search} onChange={setSearch} placeholder="Search name, phone or email" />
      {customers.isPending ? (
        <ListSkeleton />
      ) : customers.isError ? (
        <EmptyState
          icon={<IconCustomers />}
          title="Couldn’t load customers"
          message={customers.error.message}
          action={<Button onClick={() => customers.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        q ? (
          <EmptyState
            icon={<IconCustomers />}
            title="No matches"
            message={`No customer matches “${q}”.`}
          />
        ) : (
          <EmptyState
            icon={<IconCustomers />}
            title="No customers yet"
            message="Add your first customer to start quoting."
            action={<Button onClick={() => setAdding(true)}>Add customer</Button>}
          />
        )
      ) : (
        <Section
          footer={`${customers.data.total} ${customers.data.total === 1 ? 'customer' : 'customers'}`}
        >
          <List label="Customers">
            {items.map((c) => {
              const actions: SwipeAction[] = [];
              if (c.phone)
                actions.push({
                  label: 'Call',
                  tone: 'green',
                  icon: <IconPhone />,
                  onAction: () => (window.location.href = `tel:${c.phone}`),
                });
              if (c.email)
                actions.push({
                  label: 'Email',
                  tone: 'blue',
                  icon: <IconMail />,
                  onAction: () => (window.location.href = `mailto:${c.email}`),
                });
              const row = (
                <LinkRow
                  to={`/customers/${c.id}`}
                  lead={
                    <span className="row__lead" aria-hidden>
                      {initials(c.name)}
                    </span>
                  }
                  title={c.name}
                  sub={[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details yet'}
                />
              );
              return (
                <li key={c.id}>
                  {actions.length ? <SwipeRow actions={actions}>{row}</SwipeRow> : row}
                </li>
              );
            })}
          </List>
        </Section>
      )}
      <PendingCreates kind="customer" />
      <NewCustomerSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}
