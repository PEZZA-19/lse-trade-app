import {
  ALLOCATION_LABELS,
  formatPence,
  formatQty,
  parsePounds,
  parseQty,
  type Allocation,
  type BillApplyResultDto,
  type BillLineDto,
  type PriceItemDto,
} from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { usePriceList } from '../../api/billing';
import { Sheet } from '../../components/Sheet';
import {
  Button,
  ButtonRow,
  List,
  ListSkeleton,
  SearchField,
  Section,
  Segmented,
  TextField,
} from '../../components/ui';
import { useDebounced } from '../../lib/useDebounced';
import { Change } from '../pricing/Change';

/** A bill line being edited: `item` undefined = match automatically on save. */
export interface DraftLine {
  code: string | null;
  description: string;
  qtyMilli: number;
  unitCostPence: number;
  item: BillLineDto['item'] | undefined;
  updatePrice: boolean;
  allocation: Allocation;
}

/** Edit one bill line: what the bill says, which price-list item it is, and where it goes. */
export function BillLineSheet(props: {
  line: DraftLine | null;
  hasJob: boolean;
  credit: boolean;
  onClose: () => void;
  onSave: (l: DraftLine) => void;
  onRemove?: () => void;
}) {
  const l = props.line;
  const [code, setCode] = useState(l?.code ?? '');
  const [description, setDescription] = useState(l?.description ?? '');
  const [qty, setQty] = useState(l ? formatQty(l.qtyMilli) : '1');
  const [cost, setCost] = useState(l ? (l.unitCostPence / 100).toFixed(2) : '');
  const [item, setItem] = useState<DraftLine['item']>(l?.item);
  const [updatePrice, setUpdatePrice] = useState(l?.updatePrice ?? true);
  const [allocation, setAllocation] = useState<Allocation>(
    l?.allocation ?? (props.hasJob ? 'job' : 'stock'),
  );
  const [picking, setPicking] = useState(false);
  const qtyMilli = parseQty(qty);
  const unit = parsePounds(cost);
  const valid =
    !!description.trim() && qtyMilli != null && qtyMilli > 0 && unit != null && unit >= 0;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    props.onSave({
      code: code.trim() || null,
      description: description.trim(),
      qtyMilli: qtyMilli!,
      unitCostPence: unit!,
      item,
      updatePrice,
      allocation,
    });
    props.onClose();
  };
  if (picking)
    return (
      <ItemMatchSheet
        onClose={() => setPicking(false)}
        onPick={(i) => {
          setItem(
            i
              ? {
                  id: i.id,
                  code: i.code,
                  description: i.description,
                  unitCostPence: i.unitCostPence,
                  unit: i.unit,
                }
              : null,
          );
          setPicking(false);
        }}
      />
    );
  const allocations = (['job', 'stock', 'home'] as const)
    .filter((a) => a !== 'job' || props.hasJob)
    .map((a) => ({ value: a, label: ALLOCATION_LABELS[a] }));
  return (
    <Sheet
      open
      title={l ? 'Bill Line' : 'Add Line'}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!valid}
          style={{ fontWeight: 600 }}
        >
          {l ? 'Done' : 'Add'}
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section header="As on the bill">
          <List className="form-list">
            <TextField
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              // Focus only a new line: focusing a long existing value scrolls it to its end.
              data-autofocus={l ? undefined : true}
            />
            <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value)} />
            <TextField
              label="Quantity"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="decimal"
            />
            <TextField
              label="Unit cost (£)"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </List>
        </Section>
        <Section
          header="Price list"
          footer={
            item === undefined
              ? 'Matched automatically when you save: by code, then supplier and description.'
              : item && !props.credit
                ? updatePrice
                  ? 'Applying the bill updates this item’s cost (kept in its price history) and recalculates kits that use it.'
                  : 'The price list keeps its current cost.'
                : item
                  ? 'Credit notes never change list prices.'
                  : 'Counted as a cost only; the price list isn’t changed.'
          }
        >
          <List>
            <li>
              <ButtonRow
                onClick={() => setPicking(true)}
                title={
                  item
                    ? item.description
                    : item === null
                      ? 'Not on the price list'
                      : 'Match automatically'
                }
                sub={
                  item ? (
                    <>
                      {[item.code, `per ${item.unit}`].filter(Boolean).join(' · ')} ·{' '}
                      {unit != null && unit !== item.unitCostPence ? (
                        <Change from={item.unitCostPence} to={unit} label="Cost" />
                      ) : (
                        `cost ${formatPence(item.unitCostPence)}, no change`
                      )}
                    </>
                  ) : (
                    'Tap to choose an item'
                  )
                }
                chevron
              />
            </li>
            {item && !props.credit && (
              <li>
                <label className="row switch-row">
                  <span className="row__main">
                    <span className="row__title">Update list cost</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={updatePrice}
                    onChange={(e) => setUpdatePrice(e.target.checked)}
                  />
                </label>
              </li>
            )}
          </List>
        </Section>
        <Section
          header="Goes to"
          footer={
            allocation === 'job'
              ? props.credit
                ? 'Reduces the job’s material costs.'
                : 'Added to the job’s materials at cost × markup, ready for a time-and-materials invoice.'
              : allocation === 'stock'
                ? 'Kept as van or shelf stock.'
                : 'Personal, not a business cost.'
          }
        >
          <Segmented
            label="Goes to"
            value={allocation}
            onChange={setAllocation}
            options={allocations}
          />
        </Section>
        {props.onRemove && (
          <Button
            variant="destructive"
            block
            onClick={() => {
              props.onRemove!();
              props.onClose();
            }}
          >
            Remove Line
          </Button>
        )}
      </form>
    </Sheet>
  );
}

/** Choose the price-list item a bill line is, or mark it as not on the list. */
function ItemMatchSheet(props: { onClose: () => void; onPick: (i: PriceItemDto | null) => void }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const list = usePriceList(q);
  return (
    <Sheet open title="Match to Item" onClose={props.onClose}>
      <SearchField value={search} onChange={setSearch} placeholder="Search the price list" />
      <List label="Price list items">
        <li>
          <ButtonRow
            onClick={() => props.onPick(null)}
            title="Not on the price list"
            sub="Count it as a cost only"
          />
        </li>
        {list.isPending ? (
          <li>
            <ListSkeleton rows={3} />
          </li>
        ) : (
          (list.data ?? []).map((i) => (
            <li key={i.id}>
              <ButtonRow
                onClick={() => props.onPick(i)}
                title={i.description}
                sub={[i.code, i.supplier, `per ${i.unit}`].filter(Boolean).join(' · ')}
                meta={<span className="num">{formatPence(i.unitCostPence)}</span>}
              />
            </li>
          ))
        )}
      </List>
    </Sheet>
  );
}

/** What applying the bill will change, shown before the owner's tap (and after, as a summary). */
export function ApplySummary({ r }: { r: BillApplyResultDto }) {
  return (
    <>
      <Section
        header="Price list"
        footer={
          r.priceChanges.length
            ? 'Each change is kept in the item’s price history with this bill’s reference.'
            : r.unchangedPrices
              ? 'Every matched item already has this cost.'
              : 'No list prices change.'
        }
      >
        {r.priceChanges.length > 0 && (
          <List label="Price changes">
            {r.priceChanges.map((p) => (
              <li key={p.itemId}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">{p.description}</span>
                  </span>
                  <span className="row__meta">
                    <Change from={p.oldCostPence} to={p.newCostPence} label={p.description} />
                  </span>
                </div>
              </li>
            ))}
          </List>
        )}
      </Section>
      {r.kits.length > 0 && (
        <Section
          header="Kits recalculated"
          footer="Sent quotes keep their prices; draft quotes can take the new kit price."
        >
          <List label="Kit cost changes">
            {r.kits.map((k) => (
              <li key={k.kitId}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">{k.name}</span>
                    <span className="row__sub">
                      Sell <Change from={k.oldSellPence} to={k.newSellPence} />
                    </span>
                  </span>
                  <span className="row__meta">
                    <Change from={k.oldCostPence} to={k.newCostPence} label={`${k.name} cost`} />
                  </span>
                </div>
              </li>
            ))}
          </List>
        </Section>
      )}
      {r.jobLines.length > 0 && (
        <Section
          header={`Job ${r.jobNumber} materials`}
          footer={`${formatPence(r.jobLines.reduce((t, l) => t + l.totalPence, 0))} at sell price, ready to invoice.`}
        >
          <List label="Job materials">
            {r.jobLines.map((l, i) => (
              <li key={i}>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">{l.description}</span>
                    <span className="row__sub">
                      {formatQty(l.qtyMilli)} × {formatPence(l.unitSellPence)} · cost{' '}
                      {formatPence(l.unitCostPence)}
                    </span>
                  </span>
                  <span className="row__meta num">{formatPence(l.totalPence)}</span>
                </div>
              </li>
            ))}
          </List>
        </Section>
      )}
      {r.notOnPriceList > 0 && (
        <p className="sheet-hint">
          {r.notOnPriceList} {r.notOnPriceList === 1 ? 'line isn’t' : 'lines aren’t'} on the price
          list: counted as costs only.
        </p>
      )}
    </>
  );
}
