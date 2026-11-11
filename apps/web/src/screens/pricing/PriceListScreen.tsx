import { formatPence } from '@lse/shared';
import { useState } from 'react';
import { usePriceList } from '../../api/billing';
import { useSession } from '../../api/hooks';
import { IconPlus, IconWrench } from '../../components/icons';
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
  Segmented,
} from '../../components/ui';
import { useDebounced } from '../../lib/useDebounced';
import { ImportSheet } from './ImportSheet';
import { PriceItemSheet } from './PriceItemSheet';

/** Materials with supplier, cost, markup and sell. Feeds kits and quotes. */
export function PriceListScreen() {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [show, setShow] = useState<'active' | 'all'>('active');
  const list = usePriceList(q, show === 'all');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const isOwner = useSession().data?.role === 'owner';
  const items = list.data ?? [];
  return (
    <Page
      title="Price List"
      back={{ label: 'More', to: '/more' }}
      actions={
        isOwner && (
          <>
            <Button variant="plain" onClick={() => setImporting(true)}>
              Import
            </Button>
            <IconButton label="Add item" onClick={() => setAdding(true)}>
              <IconPlus />
            </IconButton>
          </>
        )
      }
    >
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder="Search item, code or supplier"
      />
      <Segmented
        label="Show"
        value={show}
        onChange={setShow}
        options={[
          { value: 'active', label: 'In use' },
          { value: 'all', label: 'Include switched off' },
        ]}
      />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <EmptyState
          icon={<IconWrench />}
          title="Couldn’t load the price list"
          message={list.error.message}
          action={<Button onClick={() => list.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconWrench />}
          title={q ? 'No matches' : 'No items yet'}
          message={
            q ? `Nothing matches “${q}”.` : 'Add items one by one, or import your merchant’s CSV.'
          }
          action={
            !q && isOwner ? (
              <Button onClick={() => setImporting(true)}>Import CSV</Button>
            ) : undefined
          }
        />
      ) : (
        <Section
          footer={`${items.length} ${items.length === 1 ? 'item' : 'items'} · sell prices include markup`}
        >
          <List label="Price list">
            {items.map((i) => (
              <li key={i.id}>
                <LinkRow
                  to={`/price-list/${i.id}`}
                  title={
                    <>
                      {i.description}
                      {!i.isActive && (
                        <span style={{ color: 'var(--label-2)', fontWeight: 400 }}> · off</span>
                      )}
                    </>
                  }
                  sub={[i.code, i.supplier, `per ${i.unit}`].filter(Boolean).join(' · ')}
                  meta={
                    <span className="num" style={{ textAlign: 'right' }}>
                      {formatPence(i.unitSellPence)}
                      <span className="row__sub" style={{ display: 'block' }}>
                        cost {formatPence(i.unitCostPence)}
                      </span>
                    </span>
                  }
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      <PriceItemSheet open={adding} onClose={() => setAdding(false)} />
      <ImportSheet open={importing} onClose={() => setImporting(false)} />
    </Page>
  );
}
