import {
  formatPence,
  formatQty,
  LINE_KINDS,
  lineTotal,
  parsePounds,
  parseQty,
  unitSell,
  type QuoteLineInput,
} from '@lse/shared';
import { useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { Button, KeyValueRow, List, Section, Segmented, TextField } from '../../components/ui';
import { LINE_KIND_LABEL } from '../../lib/status';

type Kind = (typeof LINE_KINDS)[number];

interface Draft {
  kind: Kind;
  description: string;
  qty: string;
  cost: string;
  price: string;
  markup: string;
  optional: boolean;
  optionLabel: string;
  /** A minus (credit) line: one amount taken off the quote. */
  minus: boolean;
  amount: string;
}

const pounds = (p: number | null | undefined) => (p == null ? '' : (p / 100).toFixed(2));

function toDraft(line: QuoteLineInput | undefined, labourRatePence: number): Draft {
  if (!line)
    return {
      kind: 'material',
      description: '',
      qty: '1',
      cost: '',
      price: '',
      markup: '',
      optional: false,
      optionLabel: '',
      minus: false,
      amount: '',
    };
  const minus = (line.unitPricePence ?? 0) < 0 || (line.qtyMilli ?? 1000) < 0;
  return {
    kind: line.kind,
    description: line.description,
    qty: formatQty(line.qtyMilli ?? 1000),
    cost: pounds(line.unitCostPence),
    price: pounds(
      line.unitPricePence ??
        (line.kind === 'labour' && line.unitCostPence == null ? labourRatePence : null),
    ),
    markup: line.markupBp ? formatQty(line.markupBp / 10) : '',
    optional: !!line.optionLabel,
    optionLabel: line.optionLabel ?? '',
    minus,
    amount: minus
      ? pounds(
          Math.abs(lineTotal(Math.abs(line.qtyMilli ?? 1000), Math.abs(line.unitPricePence ?? 0))),
        )
      : '',
  };
}

/**
 * Add or edit one line. Each kind shows only the fields it needs, with defaults filled in:
 * labour at the business rate, materials at cost × markup, carriage and allowances as a price.
 */
export function LineSheet(props: LineSheetProps) {
  // Mounted only while open, so the form always starts from the line being edited.
  return props.open ? <LineSheetInner {...props} /> : null;
}

interface LineSheetProps {
  open: boolean;
  line?: QuoteLineInput | undefined;
  defaultMarkupBp: number;
  labourRatePence: number;
  existingOptions: string[];
  onSave: (line: QuoteLineInput) => void;
  onDelete?: (() => void) | undefined;
  onClose: () => void;
}

function LineSheetInner(props: LineSheetProps) {
  const [d, setD] = useState<Draft>(() => toDraft(props.line, props.labourRatePence));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const qtyMilli = parseQty(d.qty || '1');
  const cost = d.cost ? parsePounds(d.cost) : null;
  const price = d.price ? parsePounds(d.price) : null;
  const markupBp = d.markup ? (parseQty(d.markup) ?? NaN) * 10 : null;
  const amount = d.amount ? parsePounds(d.amount) : null;
  const errors: Partial<Record<'qty' | 'cost' | 'price' | 'markup' | 'amount', string>> = d.minus
    ? {
        amount:
          amount == null || amount <= 0 ? 'Enter the amount to take off, e.g. 450' : undefined,
      }
    : {
        qty: qtyMilli == null || qtyMilli <= 0 ? 'Enter a quantity, e.g. 2.5' : undefined,
        cost: d.cost && cost == null ? 'Enter an amount, e.g. 12.50' : undefined,
        price: d.price && price == null ? 'Enter an amount, e.g. 45' : undefined,
        markup:
          markupBp != null && (!Number.isInteger(markupBp) || markupBp < 10000 || markupBp > 100000)
            ? 'Between 1 and 10, e.g. 1.3'
            : undefined,
      };
  const minusLine: QuoteLineInput = {
    kind: d.kind,
    description: d.description.trim(),
    qtyMilli: 1000,
    unitCostPence: null,
    unitPricePence: -Math.abs(amount ?? 0),
    markupBp: null,
    optionLabel: d.optional ? d.optionLabel.trim() || null : null,
  };
  const plainLine: QuoteLineInput = {
    kind: d.kind,
    description: d.description.trim(),
    qtyMilli: d.kind === 'labour' || d.kind === 'material' ? (qtyMilli ?? 1000) : 1000,
    unitCostPence: d.kind === 'material' || d.kind === 'pc_sum' ? cost : null,
    unitPricePence:
      d.kind === 'material' || d.kind === 'pc_sum'
        ? price
        : (price ?? (d.kind === 'labour' ? props.labourRatePence : null)),
    markupBp: d.kind === 'material' && markupBp && !errors.markup ? markupBp : null,
    optionLabel: d.optional ? d.optionLabel.trim() || null : null,
  };
  const line = d.minus ? minusLine : plainLine;
  const sell = unitSell(
    {
      kind: line.kind,
      qtyMilli: line.qtyMilli ?? 1000,
      unitCostPence: line.unitCostPence ?? null,
      markupBp: line.markupBp ?? null,
      unitPricePence: line.unitPricePence ?? null,
      optionLabel: null,
    },
    { markupBp: props.defaultMarkupBp },
  );
  const total = lineTotal(line.qtyMilli ?? 1000, sell);
  const valid =
    !!line.description &&
    !Object.values(errors).some(Boolean) &&
    (!d.optional || !!line.optionLabel);
  const save = () => {
    if (!valid) return;
    props.onSave(line);
    props.onClose();
  };

  const descPlaceholder = {
    labour: 'e.g. First fix',
    material: 'e.g. Double socket',
    carriage: 'Carriage',
    pc_sum: 'e.g. Light fittings allowance',
  }[d.kind];

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={props.line ? 'Edit Line' : 'Add Line'}
      action={
        <Button variant="plain" onClick={save} disabled={!valid} style={{ fontWeight: 600 }}>
          {props.line ? 'Done' : 'Add'}
        </Button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Segmented
          label="Type of line"
          value={d.kind}
          onChange={(k) => set('kind', k)}
          options={LINE_KINDS.map((k) => ({ value: k, label: LINE_KIND_LABEL[k] }))}
        />
        <Section>
          <List className="form-list">
            <TextField
              label="Description"
              value={d.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder={descPlaceholder}
              data-autofocus
            />
            {d.minus && (
              <TextField
                label="Amount off (£)"
                inputMode="decimal"
                value={d.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="e.g. 450"
                error={errors.amount}
              />
            )}
            {!d.minus && d.kind === 'labour' && (
              <>
                <TextField
                  label="Hours"
                  inputMode="decimal"
                  value={d.qty}
                  onChange={(e) => set('qty', e.target.value)}
                  error={errors.qty}
                />
                <TextField
                  label="Rate per hour"
                  inputMode="decimal"
                  value={d.price}
                  onChange={(e) => set('price', e.target.value)}
                  placeholder={pounds(props.labourRatePence)}
                  error={errors.price}
                />
              </>
            )}
            {!d.minus && d.kind === 'material' && (
              <>
                <TextField
                  label="Quantity"
                  inputMode="decimal"
                  value={d.qty}
                  onChange={(e) => set('qty', e.target.value)}
                  error={errors.qty}
                />
                <TextField
                  label="Cost each"
                  inputMode="decimal"
                  value={d.cost}
                  onChange={(e) => set('cost', e.target.value)}
                  placeholder="What you pay"
                  error={errors.cost}
                />
                <TextField
                  label="Markup"
                  inputMode="decimal"
                  value={d.markup}
                  onChange={(e) => set('markup', e.target.value)}
                  placeholder={`${formatQty(props.defaultMarkupBp / 10)}× (usual)`}
                  error={errors.markup}
                />
                <TextField
                  label="Fixed price"
                  inputMode="decimal"
                  value={d.price}
                  onChange={(e) => set('price', e.target.value)}
                  placeholder="Optional"
                  error={errors.price}
                />
              </>
            )}
            {!d.minus && (d.kind === 'carriage' || d.kind === 'pc_sum') && (
              <TextField
                label="Amount"
                inputMode="decimal"
                value={d.kind === 'pc_sum' ? d.cost : d.price}
                onChange={(e) => set(d.kind === 'pc_sum' ? 'cost' : 'price', e.target.value)}
                placeholder="£"
                error={d.kind === 'pc_sum' ? errors.cost : errors.price}
              />
            )}
          </List>
        </Section>

        <Section
          footer={
            d.optional
              ? 'Optional extras are shown separately. The customer chooses which ones they want.'
              : undefined
          }
        >
          <List className="form-list">
            <li>
              <label className="row" style={{ cursor: 'pointer' }}>
                <span className="row__main">Minus line (credit)</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={d.minus}
                  onChange={(e) => set('minus', e.target.checked)}
                  className="switch"
                />
              </label>
            </li>
            <li>
              <label className="row" style={{ cursor: 'pointer' }}>
                <span className="row__main">Optional extra</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={d.optional}
                  onChange={(e) => set('optional', e.target.checked)}
                  className="switch"
                />
              </label>
            </li>
            {d.optional && (
              <TextField
                label="Extra’s name"
                value={d.optionLabel}
                onChange={(e) => set('optionLabel', e.target.value)}
                placeholder="e.g. Outside light"
                list="option-labels"
              />
            )}
          </List>
          <datalist id="option-labels">
            {props.existingOptions.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </Section>

        <Section>
          <List>
            <li>
              <KeyValueRow label="Price each" value={formatPence(sell)} />
            </li>
            <li>
              <KeyValueRow label="Line total" value={formatPence(total)} strong />
            </li>
          </List>
        </Section>
        {props.onDelete && (
          <Button
            variant="destructive"
            block
            onClick={() => {
              props.onDelete?.();
              props.onClose();
            }}
          >
            Delete line
          </Button>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
