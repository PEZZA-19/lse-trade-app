import { formatMarkup, formatPence } from '@lse/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useDeletePriceItem, usePriceItem, useSavePriceItem } from '../../api/billing';
import { useSession } from '../../api/hooks';
import { IconWrench } from '../../components/icons';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  KeyValueRow,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Section,
} from '../../components/ui';
import { formatDayShort, formatTime } from '../../lib/dates';
import { ConfirmSheet } from '../invoices/InvoiceSheets';
import { Change } from './Change';
import { PriceItemSheet } from './PriceItemSheet';

const SOURCE = {
  created: 'Added',
  manual: 'Edited',
  csv: 'CSV import',
  supplier_bill: 'Supplier bill',
} as const;

export function PriceItemScreen() {
  const { id = '' } = useParams();
  const item = usePriceItem(id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isOwner = useSession().data?.role === 'owner';
  const save = useSavePriceItem(id);
  const del = useDeletePriceItem();
  const toast = useToast();
  const navigate = useNavigate();
  const back = { label: 'Price List', to: '/price-list' };
  if (item.isPending)
    return (
      <Page title="Item" back={back}>
        <ListSkeleton />
      </Page>
    );
  if (item.isError)
    return (
      <Page title="Item" back={back}>
        <EmptyState
          icon={<IconWrench />}
          title="Couldn’t load this item"
          message={item.error.message}
        />
      </Page>
    );
  const it = item.data;
  return (
    <Page
      title={it.description}
      subtitle={[it.code, it.supplier].filter(Boolean).join(' · ') || undefined}
      back={back}
      actions={
        isOwner && (
          <Button variant="plain" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )
      }
    >
      <div className="hero">
        <div className="hero__amount">{formatPence(it.unitSellPence)}</div>
        <div className="hero__meta">
          <span>per {it.unit}</span>
          {!it.isActive && <span>· switched off</span>}
        </div>
      </div>
      <Section header="Pricing">
        <List>
          <li>
            <KeyValueRow label="Cost" value={formatPence(it.unitCostPence)} />
          </li>
          <li>
            <KeyValueRow
              label="Markup"
              value={
                it.sellPricePence != null
                  ? 'Fixed sell price'
                  : it.markupBp != null
                    ? `${formatMarkup(it.markupBp)}×`
                    : 'Business default'
              }
            />
          </li>
          <li>
            <KeyValueRow label="Sell" value={formatPence(it.unitSellPence)} strong />
          </li>
        </List>
      </Section>
      {it.kits.length > 0 && (
        <Section
          header="Used in kits"
          footer="Changing the cost recalculates these kits and records their old and new cost."
        >
          <List>
            {it.kits.map((k) => (
              <li key={k.id}>
                <LinkRow to={`/kits/${k.id}`} title={k.name} />
              </li>
            ))}
          </List>
        </Section>
      )}
      <Section header="Price history">
        <List label="Price history">
          {it.history.map((h) => (
            <li key={h.id}>
              <div className="row">
                <span className="row__main">
                  <span className="row__title">{SOURCE[h.source]}</span>
                  <span className="row__sub">
                    {formatDayShort(new Date(h.createdAt))}, {formatTime(h.createdAt)}
                    {h.userName ? ` · ${h.userName}` : ''}
                    {h.reference ? ` · ${h.reference}` : ''}
                  </span>
                </span>
                <span className="row__meta">
                  {h.oldCostPence == null ? (
                    <span className="num">{formatPence(h.newCostPence)}</span>
                  ) : (
                    <Change from={h.oldCostPence} to={h.newCostPence} label="Cost" />
                  )}
                </span>
              </div>
            </li>
          ))}
        </List>
      </Section>
      {isOwner && (
        <Section
          footer={
            it.kits.length
              ? 'Items used in a kit can be switched off but not deleted.'
              : 'Switched-off items stay on old quotes but are hidden when picking.'
          }
        >
          <Button
            variant="secondary"
            block
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { isActive: !it.isActive },
                { onSuccess: () => toast.show(it.isActive ? 'Switched off' : 'Switched back on') },
              )
            }
          >
            {it.isActive ? 'Switch Off' : 'Switch On'}
          </Button>
          {it.kits.length === 0 && (
            <Button variant="destructive" block onClick={() => setDeleting(true)}>
              Delete Item
            </Button>
          )}
        </Section>
      )}
      {editing && <PriceItemSheet open item={it} onClose={() => setEditing(false)} />}
      <ConfirmSheet
        open={deleting}
        title="Delete Item"
        actionLabel="Delete"
        onConfirm={() =>
          del.mutate(it.id, {
            onSuccess: () => {
              toast.show(`${it.description} deleted`);
              navigate('/price-list', { replace: true });
            },
          })
        }
        onClose={() => setDeleting(false)}
        loading={del.isPending}
        error={del.error?.message}
      >
        <p>
          Delete “{it.description}” and its price history? Quotes that used it keep their lines.
        </p>
      </ConfirmSheet>
    </Page>
  );
}
