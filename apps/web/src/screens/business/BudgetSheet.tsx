import { PL_ACCOUNTS, budgetMonths, monthLabel, parsePounds, type BusinessDto } from '@lse/shared';
import { useState } from 'react';
import { useSetBudget } from '../../api/business';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ui';

/** Monthly budget per Profit and Loss account for one year, with "same every month". */
export function BudgetSheet(props: {
  open: boolean;
  onClose: () => void;
  data: BusinessDto;
  year: number;
}) {
  const startMonth = Number(props.data.yearStart.slice(0, 2)) || 1;
  const months = budgetMonths(props.year, startMonth);
  const initial = () =>
    Object.fromEntries(
      PL_ACCOUNTS.map((a) => [
        a.code,
        months.map((m) => {
          const v =
            props.data.budgets.find((b) => b.account === a.code && b.month === m)?.amountPence ?? 0;
          return v ? (v / 100).toFixed(2) : '';
        }),
      ]),
    ) as Record<string, string[]>;
  const [vals, setVals] = useState(initial);
  const set = useSetBudget();
  const toast = useToast();
  const bad = Object.values(vals).some((xs) =>
    xs.some((x) => x.trim() !== '' && parsePounds(x) === null),
  );
  const save = () =>
    set.mutate(
      {
        year: props.year,
        startMonth,
        lines: PL_ACCOUNTS.map((a) => ({
          account: a.code,
          months: vals[a.code]!.map((x) => (x.trim() ? (parsePounds(x) ?? 0) : 0)),
        })),
      },
      {
        onSuccess: () => {
          toast.show('Budget saved');
          props.onClose();
        },
        onError: (e) => toast.show(e.message),
      },
    );
  return (
    <Sheet
      open={props.open}
      large
      title={`Budget ${props.year}`}
      onClose={props.onClose}
      action={
        <Button variant="plain" onClick={save} disabled={bad} loading={set.isPending}>
          Save
        </Button>
      }
    >
      <div className="budget">
        {PL_ACCOUNTS.map((a) => (
          <fieldset key={a.code} className="budget__account">
            <legend>
              {a.name}
              <Button
                variant="plain"
                type="button"
                onClick={() =>
                  setVals((v) => ({ ...v, [a.code]: v[a.code]!.map(() => v[a.code]![0] ?? '') }))
                }
              >
                Same Every Month
              </Button>
            </legend>
            <div className="budget__months">
              {months.map((m, i) => (
                <label key={m}>
                  <span>{monthLabel(m).slice(0, 3)}</span>
                  <input
                    inputMode="decimal"
                    placeholder="0"
                    value={vals[a.code]![i]}
                    aria-label={`${a.name}, ${monthLabel(m)} (£)`}
                    aria-invalid={
                      vals[a.code]![i]!.trim() !== '' && parsePounds(vals[a.code]![i]!) === null
                    }
                    onChange={(e) =>
                      setVals((v) => ({
                        ...v,
                        [a.code]: v[a.code]!.map((x, k) => (k === i ? e.target.value : x)),
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <p className="section__footer">Amounts in pounds. Empty months have no budget.</p>
      </div>
    </Sheet>
  );
}
