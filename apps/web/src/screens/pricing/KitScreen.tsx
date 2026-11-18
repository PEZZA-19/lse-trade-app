import {
  formatPence,
  formatQty,
  labourValue,
  parseQty,
  type KitDetailDto,
  type PriceItemDto,
} from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useDeleteKit, useKit, usePriceList, useSaveKit } from '../../api/billing';
import { useMe, useSession } from '../../api/hooks';
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
  const [editingLabour, setEditingLabour] = useState(false);
  const rate = useMe().data?.tenant.labourRatePence ?? 4500;
  const lines = kit.lines.map((l) => ({
    itemId: l.itemId,
    qtyMilli: l.qtyMilli,
    labourMinutes: l.labourMinutes ?? 0,
  }));
  const saveKit = (patch: Parameters<typeof save.mutate>[0], done?: string) =>
    save.mutate(patch, {
      onSuccess: () => done && toast.show(done),
      onError: (e) => toast.show(`Not saved. ${e.message}`, { tone: 'error' }),
    });
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
                    {!!l.labourMinutes && <> · fit {hoursText(l.labourMinutes)} each</>}
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

      <Section
        header="Labour"
        footer={`Added to a quote as its own labour line at the charge-out rate (${formatPence(rate)}/h). You can change the hours or rate on each quote.`}
      >
        <List label="Kit labour">
          <li>
            {isOwner ? (
              <ButtonRow
                onClick={() => setEditingLabour(true)}
                title="Time for the whole kit"
                meta={<span className="num">{hoursText(kit.kitLabourMinutes ?? 0)}</span>}
              />
            ) : (
              <KeyValueRow
                label="Time for the whole kit"
                value={hoursText(kit.kitLabourMinutes ?? 0)}
              />
            )}
          </li>
          <li>
            <KeyValueRow
              label="Time from items"
              value={hoursText((kit.labourMinutes ?? 0) - (kit.kitLabourMinutes ?? 0))}
            />
          </li>
          <li>
            <KeyValueRow
              label="Labour per kit"
              value={`${hoursText(kit.labourMinutes ?? 0)} · ${formatPence(labourValue(kit.labourMinutes ?? 0, rate))}`}
              strong
            />
          </li>
        </List>
      </Section>

      <Section header="Totals">
        <List>
          <li>
            <KeyValueRow label="Kit cost" value={formatPence(kit.costPence)} />
          </li>
          <li>
            <KeyValueRow label="Kit sell (materials)" value={formatPence(kit.sellPence)} strong />
          </li>
          {!!kit.labourMinutes && (
            <li>
              <KeyValueRow
                label="With labour"
                value={formatPence(kit.sellPence + labourValue(kit.labourMinutes, rate))}
              />
            </li>
          )}
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
          onPick={(item, qtyMilli, labourMinutes) =>
            saveLines(
              [...lines, { itemId: item.id, qtyMilli, labourMinutes: labourMinutes ?? 0 }],
              `${item.description} added`,
            )
          }
        />
      )}
      {editing !== null && kit.lines[editing] && (
        <QtySheet
          title={kit.lines[editing]!.description}
          unit={kit.lines[editing]!.unit}
          qtyMilli={kit.lines[editing]!.qtyMilli}
          labourMinutes={kit.lines[editing]!.labourMinutes ?? 0}
          onClose={() => setEditing(null)}
          onSave={(q, m) =>
            saveLines(
              lines.map((l, i) =>
                i === editing ? { ...l, qtyMilli: q, labourMinutes: m ?? l.labourMinutes } : l,
              ),
            )
          }
          onRemove={() =>
            saveLines(
              lines.filter((_, i) => i !== editing),
              'Removed from kit',
            )
          }
        />
      )}
      {editingLabour && (
        <HoursSheet
          title="Kit Labour"
          label="Hours for the whole kit"
          minutes={kit.kitLabourMinutes ?? 0}
          footer="Time to fit one kit, on top of any time set on its items."
          onClose={() => setEditingLabour(false)}
          onSave={(m) => saveKit({ labourMinutes: m }, 'Labour saved')}
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
  onPick: (item: PriceItemDto, qtyMilli: number, labourMinutes?: number) => void;
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
        labourMinutes={0}
        onClose={props.onClose}
        onSave={(qty, m) => props.onPick(picked, qty, m)}
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

/** "1 h 30 min", "15 min", "None". */
export function hoursText(minutes: number) {
  if (!minutes) return 'None';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}
/** Hours typed as a decimal ("1.5") to whole minutes; null when not a number. */
export function parseHours(text: string): number | null {
  if (!text.trim()) return 0;
  const milli = parseQty(text);
  if (milli == null || milli < 0) return null;
  const m = Math.round((milli * 60) / 1000);
  return m > 100_000 ? null : m;
}
const hoursField = (minutes: number) =>
  minutes ? formatQty(Math.round((minutes * 1000) / 60)) : '';

/** One "hours" field, saved as minutes. */
export function HoursSheet(props: {
  title: string;
  label: string;
  minutes: number;
  footer?: string;
  onClose: () => void;
  onSave: (minutes: number) => void;
}) {
  const [text, setText] = useState(hoursField(props.minutes));
  const m = parseHours(text);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (m == null) return;
    props.onSave(m);
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
          disabled={m == null}
          style={{ fontWeight: 600 }}
        >
          Done
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section footer={props.footer}>
          <List className="form-list">
            <TextField
              label={props.label}
              value={text}
              onChange={(e) => setText(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              error={m == null ? 'Enter hours, e.g. 1.5' : undefined}
              data-autofocus
            />
          </List>
        </Section>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

export function QtySheet(props: {
  title: string;
  unit: string;
  qtyMilli: number;
  /** When set, also asks for fitting time per unit. */
  labourMinutes?: number;
  onClose: () => void;
  onSave: (qtyMilli: number, labourMinutes?: number) => void;
  onRemove?: () => void;
  saveLabel?: string;
}) {
  const [qty, setQty] = useState(formatQty(props.qtyMilli));
  const [hours, setHours] = useState(hoursField(props.labourMinutes ?? 0));
  const parsed = parseQty(qty);
  const mins = parseHours(hours);
  const asksLabour = props.labourMinutes !== undefined;
  const valid = parsed != null && parsed > 0 && (!asksLabour || mins != null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    props.onSave(parsed!, asksLabour ? mins! : undefined);
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
            {asksLabour && (
              <TextField
                label={`Hours to fit each ${props.unit === 'each' ? 'one' : props.unit}`}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                error={mins == null ? 'Enter hours, e.g. 0.25' : undefined}
              />
            )}
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
