import { formatPence, itemSell, parsePounds, type PriceItemDetailDto } from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useSavePriceItem } from '../../api/billing';
import { useMe } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, KeyValueRow, List, Section, TextField } from '../../components/ui';

const pounds = (p: number | null | undefined) => (p == null ? '' : (p / 100).toFixed(2));
const pct = (bp: number | null | undefined) => (bp == null ? '' : String((bp - 10000) / 100));

/** Add or edit a price-list item. Markup is a percentage (30 = 1.3x); a sell price overrides it. */
export function PriceItemSheet(props: {
  open: boolean;
  item?: PriceItemDetailDto;
  onClose: () => void;
}) {
  const it = props.item;
  const blank = () => ({
    code: it?.code ?? '',
    description: it?.description ?? '',
    unit: it?.unit ?? 'each',
    supplier: it?.supplier ?? '',
    cost: pounds(it?.unitCostPence),
    markup: pct(it?.markupBp),
    sell: pounds(it?.sellPricePence),
  });
  const [form, setForm] = useState(blank);
  const save = useSavePriceItem(it?.id);
  const me = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const set = (k: keyof ReturnType<typeof blank>) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const cost = parsePounds(form.cost);
  const markupBp = form.markup.trim() === '' ? null : Math.round(10000 + Number(form.markup) * 100);
  const sell = form.sell.trim() === '' ? null : parsePounds(form.sell);
  const markupOk =
    markupBp == null || (Number.isFinite(markupBp) && markupBp >= 10000 && markupBp <= 100000);
  const valid =
    !!form.description.trim() &&
    cost != null &&
    cost >= 0 &&
    markupOk &&
    (form.sell.trim() === '' || sell != null);
  const preview = valid
    ? itemSell(
        { unitCostPence: cost!, markupBp, sellPricePence: sell },
        me.data?.tenant.defaultMarkupBp ?? 13000,
      )
    : null;
  const fields = save.error instanceof ApiError ? save.error.fields : {};
  const close = () => {
    save.reset();
    setForm(blank());
    props.onClose();
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || save.isPending) return;
    save.mutate(
      {
        code: form.code,
        description: form.description,
        unit: form.unit || 'each',
        supplier: form.supplier,
        unitCostPence: cost!,
        markupBp,
        sellPricePence: sell,
      },
      {
        onSuccess: (r) => {
          const kits = r.kitChanges?.length ?? 0;
          toast.show(
            it
              ? `Saved${kits ? ` · ${kits} ${kits === 1 ? 'kit' : 'kits'} recalculated` : ''}`
              : `${r.description} added to the price list`,
          );
          close();
          if (!it) navigate(`/price-list/${r.id}`);
        },
      },
    );
  };
  return (
    <Sheet
      open={props.open}
      title={it ? 'Edit Item' : 'New Item'}
      onClose={close}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!valid}
          loading={save.isPending}
          style={{ fontWeight: 600 }}
        >
          {it ? 'Save' : 'Add'}
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section>
          <List className="form-list">
            <TextField
              label="Description"
              value={form.description}
              onChange={set('description')}
              placeholder="Required"
              error={fields.description}
              data-autofocus
            />
            <TextField
              label="Code"
              value={form.code}
              onChange={set('code')}
              placeholder="Optional"
              autoComplete="off"
              error={fields.code}
            />
            <TextField
              label="Supplier"
              value={form.supplier}
              onChange={set('supplier')}
              placeholder="Optional"
            />
            <TextField
              label="Unit"
              value={form.unit}
              onChange={set('unit')}
              placeholder="each, m, pack"
            />
          </List>
        </Section>
        <Section footer="Leave markup blank to use your default. A sell price, if set, is used as-is.">
          <List className="form-list">
            <TextField
              label="Cost (£)"
              value={form.cost}
              onChange={set('cost')}
              inputMode="decimal"
              placeholder="0.00"
              error={fields.unitCostPence}
            />
            <TextField
              label="Markup (%)"
              value={form.markup}
              onChange={set('markup')}
              inputMode="decimal"
              placeholder="Default"
              error={markupOk ? fields.markupBp : 'Between 0% and 900%'}
            />
            <TextField
              label="Sell price (£)"
              value={form.sell}
              onChange={set('sell')}
              inputMode="decimal"
              placeholder="From markup"
            />
          </List>
        </Section>
        <Section>
          <List>
            <li>
              <KeyValueRow
                label="Sells at"
                value={preview == null ? '—' : `${formatPence(preview)} per ${form.unit || 'each'}`}
                strong
              />
            </li>
          </List>
        </Section>
        {it && it.kitCount > 0 && (
          <p className="section__footer">
            Used in {it.kitCount} {it.kitCount === 1 ? 'kit' : 'kits'}: a new cost recalculates{' '}
            {it.kitCount === 1 ? 'it' : 'them'} and records the old and new kit cost. Sent quotes
            never change.
          </p>
        )}
        {save.isError && !Object.keys(fields).length && (
          <p className="field-error" role="alert">
            {save.error.message}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
