import { formatPence, type PriceImportResultDto } from '@lse/shared';
import { useState } from 'react';
import { useImportPrices } from '../../api/billing';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, List, Section } from '../../components/ui';
import { Change } from './Change';

const SAMPLE = 'Code,Description,Unit,Supplier,Cost,Markup,Sell';

/** Paste or pick a CSV, see exactly what would change, then import. */
export function ImportSheet(props: { open: boolean; onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PriceImportResultDto | null>(null);
  const run = useImportPrices();
  const toast = useToast();
  const close = () => {
    setCsv('');
    setPreview(null);
    run.reset();
    props.onClose();
  };
  const check = () => run.mutate({ csv, apply: false }, { onSuccess: (r) => setPreview(r) });
  const apply = () =>
    run.mutate(
      { csv, apply: true },
      {
        onSuccess: (r) => {
          toast.show(
            `Imported: ${r.created.length} new, ${r.updated.length} updated` +
              (r.kits.length
                ? ` · ${r.kits.length} ${r.kits.length === 1 ? 'kit' : 'kits'} recalculated`
                : ''),
          );
          close();
        },
      },
    );
  const changes = preview ? preview.created.length + preview.updated.length : 0;
  return (
    <Sheet
      open={props.open}
      title="Import Price List"
      onClose={close}
      action={
        preview ? (
          <Button
            variant="plain"
            onClick={apply}
            disabled={!changes}
            loading={run.isPending}
            style={{ fontWeight: 600 }}
          >
            Import
          </Button>
        ) : (
          <Button
            variant="plain"
            onClick={check}
            disabled={!csv.trim()}
            loading={run.isPending}
            style={{ fontWeight: 600 }}
          >
            Preview
          </Button>
        )
      }
    >
      {!preview ? (
        <>
          <Section
            footer={`Columns can be in any order. Needs Description and Cost; Code, Supplier, Unit, Markup (%) and Sell are optional. Rows match on Code, else Supplier + Description. Header: ${SAMPLE}`}
          >
            <List className="form-list">
              <li>
                <div className="row">
                  <textarea
                    className="field__input import-box"
                    aria-label="CSV"
                    placeholder={`${SAMPLE}\nTE25,2.5mm twin & earth,m,Island Electrical,0.98,,`}
                    value={csv}
                    onChange={(e) => setCsv(e.target.value)}
                    data-autofocus
                  />
                </div>
              </li>
            </List>
          </Section>
          <label className="btn btn--secondary btn--block" style={{ cursor: 'pointer' }}>
            Choose CSV file…
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setCsv(await f.text());
              }}
            />
          </label>
          {run.isError && (
            <p className="field-error" role="alert">
              {run.error.message}
            </p>
          )}
        </>
      ) : (
        <>
          <Section
            header="Nothing is saved yet"
            footer={changes ? 'Tap Import to apply these changes.' : 'Nothing to change.'}
          >
            <List>
              <li>
                <div className="row">
                  <span className="row__main">
                    <span className="row__title">
                      {preview.created.length} new · {preview.updated.length} updated ·{' '}
                      {preview.unchanged} unchanged
                    </span>
                    {preview.errors.length > 0 && (
                      <span className="row__sub" style={{ color: 'var(--red)' }}>
                        {preview.errors.length} {preview.errors.length === 1 ? 'row' : 'rows'}{' '}
                        skipped
                      </span>
                    )}
                  </span>
                </div>
              </li>
            </List>
          </Section>
          {preview.updated.length > 0 && (
            <Section header="Price changes">
              <List>
                {preview.updated.map((u) => (
                  <li key={u.itemId}>
                    <div className="row">
                      <span className="row__main">
                        <span className="row__title">{u.description}</span>
                        <span className="row__sub">Row {u.row}</span>
                      </span>
                      <span className="row__meta">
                        {u.oldCostPence !== u.newCostPence ? (
                          <Change from={u.oldCostPence} to={u.newCostPence} />
                        ) : (
                          'Details only'
                        )}
                      </span>
                    </div>
                  </li>
                ))}
              </List>
            </Section>
          )}
          {preview.kits.length > 0 && (
            <Section header="Kits that will recalculate" footer="Sent quotes keep their prices.">
              <List>
                {preview.kits.map((k) => (
                  <li key={k.kitId}>
                    <div className="row">
                      <span className="row__main">
                        <span className="row__title">{k.name}</span>
                        <span className="row__sub">
                          Sell <Change from={k.oldSellPence} to={k.newSellPence} />
                        </span>
                      </span>
                      <span className="row__meta">
                        Cost <Change from={k.oldCostPence} to={k.newCostPence} />
                      </span>
                    </div>
                  </li>
                ))}
              </List>
            </Section>
          )}
          {preview.created.length > 0 && (
            <Section header="New items">
              <List>
                {preview.created.slice(0, 50).map((c, i) => (
                  <li key={i}>
                    <div className="row">
                      <span className="row__main">
                        <span className="row__title">{c.description}</span>
                        <span className="row__sub">
                          {[c.code, c.supplier, c.unit].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="row__meta num">{formatPence(c.unitCostPence)}</span>
                    </div>
                  </li>
                ))}
              </List>
            </Section>
          )}
          {preview.errors.length > 0 && (
            <Section header="Skipped rows">
              <List>
                {preview.errors.map((e) => (
                  <li key={e.row}>
                    <div className="row">
                      <span className="row__main">
                        <span className="row__title">Row {e.row}</span>
                        <span className="row__sub">{e.message}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </List>
            </Section>
          )}
          <Button variant="secondary" block onClick={() => setPreview(null)}>
            Back to the file
          </Button>
        </>
      )}
    </Sheet>
  );
}
