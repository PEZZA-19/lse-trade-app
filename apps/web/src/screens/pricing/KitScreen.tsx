import {
  formatPence,
  formatQty,
  parseQty,
  type KitDetailDto,
  type PriceItemDto,
} from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useDeleteKit, useKit, usePriceList, useSaveKit } from '../../api/billing';
import { useSession } from '../../api/hooks';
import { IconPlusCircle, IconWrench } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  ButtonRow,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  SearchField,
  Section,
  TextField,
} from '../../components/ui';
import { formatDayShort } from '../../lib/dates';
import { useDebounced } from '../../lib/useDebounced';
import { ConfirmSheet } from '../invoices/InvoiceSheets';
import { Change } from './Change';

const SOURCE = {
  created: 'New item',
  manual: 'Price edited',
  csv: 'CSV import',
  supplier_bill: 'Supplier bill',
} as const;

export function KitScreen() {
  const { id = '' } = useParams();
  const kit = useKit(id);
  const back = { label: 'Kits', to: '/kits' };
  if (kit.isPending)
    return (
      <Page title="Kit" back={back}>
        <ListSkeleton />
      </Page>
    );
  if (kit.isError)
    return (
      <Page title="Kit" back={back}>
        <EmptyState
          icon={<IconWrench />}
          title="Couldn’t load this kit"
          message={kit.error.message}
        />
      </Page>
    );
  return <KitView kit={kit.data} />;
}

function KitView({ kit }: { kit: KitDetailDto }) {
  const isOwner = useSession().data?.role === 'owner';
  const save = useSaveKit(kit.id);
  const del = useDeleteKit();
  const toast = useToast();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const lines = kit.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli }));
  const saveLines = (next: typeof lines, done?: string) =>
    save.mutate(
      { lines: next },
      {
        onSuccess: () => done && toast.show(done),
        onError: (e) => toast.show(`Not saved. ${e.message}`, { tone: 'error' }),
      },
    );
  const margin = kit.sellPence - kit.costPence;
  return (
    <Page
      title={kit.name}
      subtitle={kit.description ?? undefined}
      back={{ label: 'Kits', to: '/kits' }}
    >
      <div className="hero">
        <div className="hero__amount">{formatPence(kit.sellPence)}</div>
        <div className="hero__meta">
          <span>cost {formatPence(kit.costPence)}</span>
          <span>·</span>
          <span>margin {formatPence(margin)}</span>
        </div>
      </div>

      <Section header="Items" footer={isOwner ? 'Tap an item to change the quantity.' : undefined}>
        <List label="Kit items">
          {kit.lines.map((l, i) => {
            const row = (
              <>
                <span className="row__main">
                  <span className="row__title">
                    {l.description}
                    {!l.isActive && (
                      <span style={{ color: 'var(--orange)', fontWeight: 400 }}>
                        {' '}
                        · switched off
                      </span>
                    )}
                  </span>
                  <span className="row__sub">
                    {formatQty(l.qtyMilli)} {l.unit} × {formatPence(l.unitSellPence)} · cost{' '}
                    {formatPence(l.lineCostPence)}
                  </span>
                </span>
                <span className="row__meta num" style={{ color: 'var(--label)' }}>
                  {formatPence(l.lineSellPence)}
                </span>
              </>
            );
            return (
              <li key={`${l.itemId}-${i}`}>
                {isOwner ? (
                  <button type="button" className="row" onClick={() => setEditing(i)}>
                    {row}
                  </button>
                ) : (
                  <div className="row">{row}</div>
                )}
              </li>
            );
          })}
          {isOwner && (
            <li>
              <ButtonRow
                onClick={() => setPicking(true)}
                lead={<IconPlusCircle width={22} height={22} color="var(--accent)" />}
                title={<span style={{ color: 'var(--accent)' }}>Add item from price list</span>}
              />
            </li>
          )}
        </List>
      </Section>

      <Section header="Totals">
        <List>
          <li>
            <KeyValueRow label="Kit cost" value={formatPence(kit.costPence)} />
          </li>
          <li>
            <KeyValueRow label="Kit sell" value={formatPence(kit.sellPence)} strong />
          </li>
        </List>
      </Section>

      <Section
        header="Cost changes"
        footer="Recorded whenever an item price changes. Quotes already sent never change; a draft quote can take the new price."
      >
        <List label="Kit cost changes">
          {kit.changes.length === 0 ? (
            <li>
              <div className="row" style={{ color: 'var(--label-2)' }}>
                No price changes yet
              </div>
            </li>
          ) : (
            kit.changes.map((c) => (
              <li key={c.id}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">{c.itemDescription}</span>
                    <span className="row__sub">
                      {SOURCE[c.source]} · {formatDayShort(new Date(c.createdAt))} · sell{' '}
                      <Change from={c.oldSellPence} to={c.newSellPence} />
                    </span>
                  </span>
                  <span className="row__meta">
                    <Change from={c.oldCostPence} to={c.newCostPence} label="Cost" />
                  </span>
                </div>
              </li>
            ))
          )}
        </List>
      </Section>

      {isOwner && (
        <Button variant="destructive" block onClick={() => setDeleting(true)}>
          Delete Kit
        </Button>
      )}

      {picking && (
        <ItemPickerSheet
          onClose={() => setPicking(false)}
          onPick={(item, qtyMilli) =>
            saveLines([...lines, { itemId: item.id, qtyMilli }], `${item.description} added`)
          }
        />
      )}
      {editing !== null && kit.lines[editing] && (
        <QtySheet
          title={kit.lines[editing]!.description}
          unit={kit.lines[editing]!.unit}
          qtyMilli={kit.lines[editing]!.qtyMilli}
          onClose={() => setEditing(null)}
          onSave={(q) =>
            saveLines(lines.map((l, i) => (i === editing ? { ...l, qtyMilli: q } : l)))
          }
          onRemove={() =>
            saveLines(
              lines.filter((_, i) => i !== editing),
              'Removed from kit',
            )
          }
        />
      )}
      <ConfirmSheet
        open={deleting}
        title="Delete Kit"
        actionLabel="Delete"
        onConfirm={() =>
          del.mutate(kit.id, {
            onSuccess: () => {
              toast.show(`${kit.name} deleted`);
              navigate('/kits', { replace: true });
            },
          })
        }
        onClose={() => setDeleting(false)}
        loading={del.isPending}
        error={del.error?.message}
      >
        <p>Delete “{kit.name}”? Quotes that already use it keep their copy of the kit.</p>
      </ConfirmSheet>
    </Page>
  );
}

/** Search the price list and pick an item with a quantity. */
export function ItemPickerSheet(props: {
  onClose: () => void;
  onPick: (item: PriceItemDto, qtyMilli: number) => void;
}) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const list = usePriceList(q);
  const [picked, setPicked] = useState<PriceItemDto | null>(null);
  if (picked)
    return (
      <QtySheet
        title={picked.description}
        unit={picked.unit}
        qtyMilli={1000}
        onClose={props.onClose}
        onSave={(qty) => props.onPick(picked, qty)}
        saveLabel="Add"
      />
    );
  return (
    <Sheet open title="Add Item" onClose={props.onClose}>
      <SearchField value={search} onChange={setSearch} placeholder="Search the price list" />
      {list.isPending ? (
        <ListSkeleton rows={3} />
      ) : (
        <List label="Price list items">
          {(list.data ?? []).map((i) => (
            <li key={i.id}>
              <ButtonRow
                onClick={() => setPicked(i)}
                title={i.description}
                sub={[i.code, i.supplier, `per ${i.unit}`].filter(Boolean).join(' · ')}
                meta={<span className="num">{formatPence(i.unitSellPence)}</span>}
              />
            </li>
          ))}
          {list.data?.length === 0 && (
            <li>
              <div className="row" style={{ color: 'var(--label-2)' }}>
                No items match. Add it to the price list first.
              </div>
            </li>
          )}
        </List>
      )}
    </Sheet>
  );
}

export function QtySheet(props: {
  title: string;
  unit: string;
  qtyMilli: number;
  onClose: () => void;
  onSave: (qtyMilli: number) => void;
  onRemove?: () => void;
  saveLabel?: string;
}) {
  const [qty, setQty] = useState(formatQty(props.qtyMilli));
  const parsed = parseQty(qty);
  const valid = parsed != null && parsed > 0;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    props.onSave(parsed!);
    props.onClose();
  };
  return (
    <Sheet
      open
      title={props.title}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!valid}
          style={{ fontWeight: 600 }}
        >
          {props.saveLabel ?? 'Done'}
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section>
          <List className="form-list">
            <TextField
              label={`Quantity (${props.unit})`}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="decimal"
              data-autofocus
            />
          </List>
        </Section>
        {props.onRemove && (
          <Button
            variant="destructive"
            block
            onClick={() => {
              props.onRemove?.();
              props.onClose();
            }}
          >
            Remove from Kit
          </Button>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
