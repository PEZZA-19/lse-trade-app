import {
  expandKitLine,
  formatPence,
  formatQty,
  kitPriceChanged,
  kitQuoteLine,
  lineTotal,
  parseQty,
  snapshotFromKit,
  type QuoteKitSnapshot,
  type QuoteLineInput,
} from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { useKit, useKits } from '../../api/billing';
import { Sheet } from '../../components/Sheet';
import {
  Button,
  ButtonRow,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Section,
  TextField,
} from '../../components/ui';
import { IconBox } from '../../components/icons';
import { Change } from '../pricing/Change';

type KitLine = QuoteLineInput & { kit: QuoteKitSnapshot };

/** "12 m 2.5mm cable · 1 Double socket · …" */
export const componentsSummary = (kit: QuoteKitSnapshot) =>
  kit.components
    .map((c) => `${formatQty(c.qtyMilli)}${c.unit === 'each' ? '' : ` ${c.unit}`} ${c.description}`)
    .join(' · ');

/** Pick a kit and how many: added as one costed block. */
export function KitPickerSheet(props: {
  onClose: () => void;
  onAdd: (line: QuoteLineInput) => void;
}) {
  const kits = useKits();
  const [kitId, setKitId] = useState<string | null>(null);
  const kit = useKit(kitId);
  const [qty, setQty] = useState('1');
  const parsed = parseQty(qty);
  const ready = !!kit.data && parsed != null && parsed > 0;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    props.onAdd(kitQuoteLine(snapshotFromKit(kit.data!), parsed!));
    props.onClose();
  };
  if (kitId)
    return (
      <Sheet
        open
        title={kit.data?.name ?? 'Kit'}
        onClose={props.onClose}
        action={
          <Button
            variant="plain"
            onClick={() => submit()}
            disabled={!ready}
            style={{ fontWeight: 600 }}
          >
            Add
          </Button>
        }
      >
        {kit.isPending ? (
          <ListSkeleton rows={3} />
        ) : kit.data ? (
          <form onSubmit={submit}>
            <Section footer={componentsSummary(snapshotFromKit(kit.data))}>
              <List className="form-list">
                <TextField
                  label="How many kits"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  inputMode="decimal"
                  data-autofocus
                />
              </List>
            </Section>
            <Section footer="Added as one line at today’s price. You can expand it into its items later.">
              <List>
                <li>
                  <KeyValueRow label="Each" value={formatPence(kit.data.sellPence)} />
                </li>
                <li>
                  <KeyValueRow
                    label="Line total"
                    value={
                      parsed && parsed > 0
                        ? formatPence(lineTotal(parsed, kit.data.sellPence))
                        : '—'
                    }
                    strong
                  />
                </li>
              </List>
            </Section>
            <button type="submit" hidden />
          </form>
        ) : (
          <p className="field-error">{kit.error?.message}</p>
        )}
      </Sheet>
    );
  return (
    <Sheet open title="Add Kit" onClose={props.onClose}>
      {kits.isPending ? (
        <ListSkeleton rows={3} />
      ) : !kits.data?.length ? (
        <EmptyState icon={<IconBox />} title="No kits yet" message="Make kits under More → Kits." />
      ) : (
        <List label="Kits">
          {kits.data.map((k) => (
            <li key={k.id}>
              <ButtonRow
                onClick={() => setKitId(k.id)}
                title={k.name}
                sub={`${k.lineCount} ${k.lineCount === 1 ? 'item' : 'items'}`}
                meta={<span className="num">{formatPence(k.sellPence)}</span>}
              />
            </li>
          ))}
        </List>
      )}
    </Sheet>
  );
}

/** A kit block on a draft quote: change how many, take the latest price, expand, or remove. */
export function KitLineSheet(props: {
  line: KitLine;
  onClose: () => void;
  onReplace: (lines: QuoteLineInput[]) => void;
  onRemove: () => void;
}) {
  const l = props.line;
  const current = useKit(l.kit.kitId);
  const [qty, setQty] = useState(formatQty(l.qtyMilli ?? 1000));
  const parsed = parseQty(qty);
  const valid = parsed != null && parsed > 0;
  const changed = current.data && kitPriceChanged(l.kit, current.data);
  const withQty = (line: QuoteLineInput) => ({
    ...line,
    qtyMilli: valid ? parsed! : (l.qtyMilli ?? 1000),
  });
  const done = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    props.onReplace([withQty(l)]);
    props.onClose();
  };
  return (
    <Sheet
      open
      title={l.kit.name}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => done()}
          disabled={!valid}
          style={{ fontWeight: 600 }}
        >
          Done
        </Button>
      }
    >
      <form onSubmit={done}>
        <Section footer={componentsSummary(l.kit)}>
          <List className="form-list">
            <TextField
              label="How many kits"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="decimal"
              data-autofocus
            />
          </List>
        </Section>
        <Section>
          <List>
            <li>
              <KeyValueRow label="Each (as added)" value={formatPence(l.kit.sellPence)} />
            </li>
            <li>
              <KeyValueRow
                label="Line total"
                value={valid ? formatPence(lineTotal(parsed!, l.kit.sellPence)) : '—'}
                strong
              />
            </li>
          </List>
        </Section>
        {changed && current.data && (
          <Section
            header="Kit price has changed"
            footer="Takes the kit’s current items and prices. Quotes already sent never change."
          >
            <List>
              <li>
                <KeyValueRow
                  label="Sell each"
                  value={<Change from={l.kit.sellPence} to={current.data.sellPence} />}
                />
              </li>
              <li>
                <KeyValueRow
                  label="Cost each"
                  value={<Change from={l.kit.costPence} to={current.data.costPence} />}
                />
              </li>
            </List>
            <Button
              block
              onClick={() => {
                props.onReplace([
                  withQty(
                    kitQuoteLine(snapshotFromKit(current.data!), 1000, l.optionLabel ?? null),
                  ),
                ]);
                props.onClose();
              }}
            >
              Use New Price
            </Button>
          </Section>
        )}
        {current.isError && (
          <p className="section__footer">This kit has been deleted. The quote keeps its copy.</p>
        )}
        <Section footer="Replaces the block with its items at the prices above. The total can differ by a penny from rounding.">
          <Button
            variant="secondary"
            block
            onClick={() => {
              props.onReplace(
                expandKitLine({ ...withQty(l), optionLabel: l.optionLabel ?? null, kit: l.kit }),
              );
              props.onClose();
            }}
          >
            Expand into Items
          </Button>
        </Section>
        <Button
          variant="destructive"
          block
          onClick={() => {
            props.onRemove();
            props.onClose();
          }}
        >
          Remove Kit
        </Button>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
