import { formatPence, type QuoteStatus } from '@lse/shared';
import { PendingCreates } from '../components/PendingCreates';
import { useState } from 'react';
import { useQuotes } from '../api/hooks';
import { IconPlus, IconQuotes } from '../components/icons';
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
import { QUOTE_STATUS, shortDate } from '../lib/status';
import { useDebounced } from '../lib/useDebounced';
import { NewQuoteSheet } from './sheets/NewQuoteSheet';

type Filter = 'all' | 'draft' | 'sent' | 'accepted';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
];

export function QuotesScreen() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useDebounced(search.trim());
  const quotes = useQuotes(filter === 'all' ? undefined : (filter as QuoteStatus), q);
  const items = quotes.data?.items ?? [];

  return (
    <Page
      title="Quotes"
      actions={
        <IconButton label="New quote" onClick={() => setAdding(true)}>
          <IconPlus />
        </IconButton>
      }
    >
      <SearchField value={search} onChange={setSearch} placeholder="Search quotes" />
      <Segmented label="Filter quotes" value={filter} onChange={setFilter} options={FILTERS} />
      {quotes.isPending ? (
        <ListSkeleton />
      ) : quotes.isError ? (
        <EmptyState
          icon={<IconQuotes />}
          title="Couldn’t load quotes"
          message={quotes.error.message}
          action={<Button onClick={() => quotes.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconQuotes />}
          title={q || filter !== 'all' ? 'Nothing here' : 'No quotes yet'}
          message={
            q || filter !== 'all'
              ? 'No quotes match this filter.'
              : 'Create a quote, then turn it into a job when the customer says yes.'
          }
          action={
            filter === 'all' && !q ? (
              <Button onClick={() => setAdding(true)}>New quote</Button>
            ) : undefined
          }
        />
      ) : (
        <Section footer={`${quotes.data.total} ${quotes.data.total === 1 ? 'quote' : 'quotes'}`}>
          <List label="Quotes">
            {items.map((x) => (
              <li key={x.id}>
                <LinkRow
                  to={`/quotes/${x.id}`}
                  title={x.title}
                  sub={`${x.displayNumber} · ${x.customerName} · ${shortDate(x.updatedAt)}`}
                  meta={
                    <>
                      <span className="num" style={{ color: 'var(--label)' }}>
                        {formatPence(x.totalPence)}
                      </span>
                      <Pill tone={QUOTE_STATUS[x.status].tone}>
                        {x.status === 'converted' && x.convertedJobNumber
                          ? `Job ${x.convertedJobNumber}`
                          : QUOTE_STATUS[x.status].label}
                      </Pill>
                    </>
                  }
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      <PendingCreates kind="quote" />
      <NewQuoteSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}
