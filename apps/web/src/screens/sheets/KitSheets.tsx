import {
  expandKitLine,
  formatPence,
  formatQty,
  kitAddLines,
  kitLabourLine,
  kitPriceChanged,
  kitQuoteLine,
  lineTotal,
  parsePounds,
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
import { hoursText, parseHours } from '../pricing/KitScreen';

const poundsText = (p: number) => (p / 100).toFixed(2);
const hoursField = (minutes: number) =>
  minutes ? formatQty(Math.round((minutes * 1000) / 60)) : '';

/** Hours-per-kit and charge-out rate fields, shared by the picker and the block editor. */
function useLabourFields(minutes: number, ratePence: number) {
  const [hours, setHours] = useState(hoursField(minutes));
  const [rate, setRate] = useState(poundsText(ratePence));
  const mins = parseHours(hours);
  const ratePenceParsed = rate.trim() ? parsePounds(rate) : ratePence;
  const errors = {
    hours: mins == null ? 'Enter hours, e.g. 1.5' : undefined,
    rate: ratePenceParsed == null ? 'Enter an amount, e.g. 55' : undefined,
  };
  const fields = (
    <>
      <TextField
        label="Labour hours per kit"
        value={hours}
        onChange={(e) => setHours(e.target.value)}
        inputMode="decimal"
        placeholder="0"
        error={errors.hours}
      />
      <TextField
        label="Charge-out rate (£/h)"
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        inputMode="decimal"
        error={errors.rate}
      />
    </>
  );
  return {
    fields,
    minutes: mins ?? 0,
    ratePence: ratePenceParsed ?? ratePence,
    valid: !errors.hours && !errors.rate,
  };
}

/** Labour for n kits at the rate, as a line total. */
const labourTotal = (minutes: number, kitsMilli: number, ratePence: number) =>
  minutes > 0 ? lineTotal(kitLabourLine('', minutes, kitsMilli, ratePence).qtyMilli, ratePence) : 0;

type KitLine = QuoteLineInput & { kit: QuoteKitSnapshot };

/** "12 m 2.5mm cable · 1 Double socket · …" */
export const componentsSummary = (kit: QuoteKitSnapshot) =>
  kit.components
    .map((c) => `${formatQty(c.qtyMilli)}${c.unit === 'each' ? '' : ` ${c.unit}`} ${c.description}`)
    .join(' · ');

/** Pick a kit and how many: added as one costed block. */
export function KitPickerSheet(props: {
  labourRatePence: number;
  onClose: () => void;
  onAdd: (lines: QuoteLineInput[]) => void;
}) {
  const kits = useKits();
  const [kitId, setKitId] = useState<string | null>(null);
  const kit = useKit(kitId);
  if (kitId && kit.data)
    return (
      <KitPickerDetail
        kit={kit.data}
        labourRatePence={props.labourRatePence}
        onClose={props.onClose}
        onAdd={props.onAdd}
      />
    );
  if (kitId)
    return (
      <Sheet open title="Kit" onClose={props.onClose}>
        {kit.isPending ? (
          <ListSkeleton rows={3} />
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
                sub={
                  k.lineCount === 0
                    ? `Labour only${k.labourMinutes ? ` · ${hoursText(k.labourMinutes)}` : ''}`
                    : `${k.lineCount} ${k.lineCount === 1 ? 'item' : 'items'}${k.labourMinutes ? ` · ${hoursText(k.labourMinutes)} labour` : ''}`
                }
                meta={<span className="num">{formatPence(k.sellPence)}</span>}
              />
            </li>
          ))}
        </List>
      )}
    </Sheet>
  );
}

function KitPickerDetail(props: {
  kit: Parameters<typeof snapshotFromKit>[0] & { labourMinutes: number };
  labourRatePence: number;
  onClose: () => void;
  onAdd: (lines: QuoteLineInput[]) => void;
}) {
  const k = props.kit;
  const [qty, setQty] = useState('1');
  const parsed = parseQty(qty);
  const labour = useLabourFields(k.labourMinutes, props.labourRatePence);
  const hasItems = k.lines.length > 0;
  // Labour is optional per kit (Joe, 18 Nov 2026): on when the kit has fitting time or no items.
  const [withLabour, setWithLabour] = useState(k.labourMinutes > 0 || !hasItems);
  const snap = snapshotFromKit(k);
  const kits = parsed != null && parsed > 0 ? parsed : 1000;
  const plan = kitAddLines(snap, kits, {
    include: withLabour,
    minutesPerKit: labour.minutes,
    ratePence: labour.ratePence,
  });
  const ready = parsed != null && parsed > 0 && (!withLabour || labour.valid) && 'lines' in plan;
  const materials = hasItems ? lineTotal(kits, k.sellPence) : 0;
  const labourPence = withLabour ? labourTotal(labour.minutes, kits, labour.ratePence) : 0;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || !('lines' in plan)) return;
    props.onAdd(plan.lines);
    props.onClose();
  };
  return (
    <Sheet
      open
      title={k.name}
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
      <form onSubmit={submit}>
        <Section footer={hasItems ? componentsSummary(snap) : 'Labour only (no items).'}>
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
        <Section
          header="Labour"
          footer={
            withLabour
              ? 'Added as its own labour line under the kit.'
              : hasItems
                ? 'Items only: no labour line is added.'
                : 'This kit has no items, so switch labour on to add it.'
          }
        >
          <List className="form-list">
            <li>
              <label className="row" style={{ cursor: 'pointer' }}>
                <span className="row__main">Include labour</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={withLabour}
                  onChange={(e) => setWithLabour(e.target.checked)}
                  className="switch"
                />
              </label>
            </li>
            {withLabour && labour.fields}
          </List>
          {'error' in plan && parsed != null && parsed > 0 && (
            <p className="field-error" role="alert">
              {plan.error}
            </p>
          )}
        </Section>
        <Section
          footer={
            hasItems
              ? 'Materials at today’s price. You can expand the kit into its items later.'
              : 'Labour only: this kit has no items.'
          }
        >
          <List>
            {hasItems && (
              <li>
                <KeyValueRow label="Materials" value={ready ? formatPence(materials) : '—'} />
              </li>
            )}
            {withLabour && (
              <li>
                <KeyValueRow label="Labour" value={ready ? formatPence(labourPence) : '—'} />
              </li>
            )}
            <li>
              <KeyValueRow
                label="Total"
                value={ready ? formatPence(materials + labourPence) : '—'}
                strong
              />
            </li>
          </List>
        </Section>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

/** A kit block on a draft quote: change how many, take the latest price, expand, or remove. */
export function KitLineSheet(props: {
  line: KitLine;
  /** The labour line that follows the block, if there is one. */
  labour?: QuoteLineInput | undefined;
  labourRatePence: number;
  onClose: () => void;
  /** Replaces the block and its labour line (if any) with these lines. */
  onReplace: (lines: QuoteLineInput[]) => void;
  onRemove: () => void;
}) {
  const l = props.line;
  const current = useKit(l.kit.kitId);
  const [qty, setQty] = useState(formatQty(l.qtyMilli ?? 1000));
  const parsed = parseQty(qty);
  const kitsBefore = l.qtyMilli ?? 1000;
  const minutesBefore = props.labour
    ? Math.round(((props.labour.qtyMilli ?? 1000) * 60) / kitsBefore)
    : 0;
  const labour = useLabourFields(
    minutesBefore,
    props.labour?.unitPricePence ?? props.labourRatePence,
  );
  const valid = parsed != null && parsed > 0 && labour.valid;
  const changed = current.data && kitPriceChanged(l.kit, current.data);
  const kits = valid ? parsed! : kitsBefore;
  const withQty = (line: QuoteLineInput) => ({ ...line, qtyMilli: kits });
  /** The labour line for the current fields: kept in step with the number of kits. */
  const labourLines = (): QuoteLineInput[] =>
    labour.minutes > 0
      ? [
          {
            ...kitLabourLine(
              l.kit.name,
              labour.minutes,
              kits,
              labour.ratePence,
              l.optionLabel ?? null,
            ),
            taxRateBp: props.labour?.taxRateBp ?? l.taxRateBp ?? 0,
          },
        ]
      : [];
  const materials = lineTotal(kits, l.kit.sellPence);
  const labourPence = labourTotal(labour.minutes, kits, labour.ratePence);
  const done = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    props.onReplace([withQty(l), ...labourLines()]);
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
        <Section
          header="Labour"
          footer={`Its own labour line under the kit, kept in step with the number of kits.${l.kit.labourMinutes ? ` The kit says ${hoursText(l.kit.labourMinutes)} each.` : ''}`}
        >
          <List className="form-list">{labour.fields}</List>
        </Section>
        <Section>
          <List>
            <li>
              <KeyValueRow label="Each (as added)" value={formatPence(l.kit.sellPence)} />
            </li>
            <li>
              <KeyValueRow label="Materials" value={valid ? formatPence(materials) : '—'} />
            </li>
            <li>
              <KeyValueRow label="Labour" value={valid ? formatPence(labourPence) : '—'} />
            </li>
            <li>
              <KeyValueRow
                label="Total"
                value={valid ? formatPence(materials + labourPence) : '—'}
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
                  ...labourLines(),
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
              props.onReplace([
                ...expandKitLine({ ...withQty(l), optionLabel: l.optionLabel ?? null, kit: l.kit }),
                ...labourLines(),
              ]);
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
