import { formatPence, lineTotal, sellFromCost, type Pence } from './money';

export type LineKind = 'labour' | 'material' | 'carriage' | 'pc_sum';

export interface PricedLineInput {
  kind: LineKind;
  qtyMilli: number;
  /** Cost per unit in pence (what we pay). Optional for labour charged at a rate. */
  unitCostPence: Pence | null;
  /** Markup multiplier in basis points; null = use the default. */
  markupBp: number | null;
  /** Explicit sell price per unit; wins over cost x markup when set. */
  unitPricePence: Pence | null;
  /** Null = core scope; otherwise the name of an optional extra. */
  optionLabel: string | null;
}

export interface PricingDefaults {
  /** Default material markup, e.g. 13000 (1.3x). */
  markupBp: number;
}

/** Unit sell price for one line: explicit price, else cost x markup (rounded up), else 0. */
export function unitSell(line: PricedLineInput, defaults: PricingDefaults): Pence {
  if (line.unitPricePence != null) return line.unitPricePence;
  if (line.unitCostPence != null) {
    // PC sums are passed through at cost unless a markup is set explicitly on the line.
    const markup = line.markupBp ?? (line.kind === 'pc_sum' ? 10000 : defaults.markupBp);
    return sellFromCost(line.unitCostPence, markup);
  }
  return 0;
}

/** qty x unit, rounded up in size: a minus (credit) line mirrors the same plus line exactly. */
function signedTotal(qtyMilli: number, unitPence: Pence): Pence {
  const t = lineTotal(Math.abs(qtyMilli), Math.abs(unitPence));
  return qtyMilli < 0 !== unitPence < 0 && t !== 0 ? -t : t;
}

export function pricedLineTotal(line: PricedLineInput, defaults: PricingDefaults): Pence {
  return signedTotal(line.qtyMilli, unitSell(line, defaults));
}

export interface QuoteTotals {
  /** Core scope, always included. */
  corePence: Pence;
  /** Total for each optional extra, keyed by option label. */
  options: Record<string, Pence>;
  /** Core plus the accepted options. */
  totalPence: Pence;
  /** Total cost of core + accepted options, for margin. Lines without cost count as zero. */
  costPence: Pence;
}

export function quoteTotals(
  lines: PricedLineInput[],
  defaults: PricingDefaults,
  acceptedOptions: readonly string[] = [],
): QuoteTotals {
  const accepted = new Set(acceptedOptions);
  let corePence = 0;
  let costPence = 0;
  const options: Record<string, Pence> = {};
  for (const line of lines) {
    const total = pricedLineTotal(line, defaults);
    const cost = line.unitCostPence != null ? signedTotal(line.qtyMilli, line.unitCostPence) : 0;
    if (line.optionLabel == null) {
      corePence += total;
      costPence += cost;
    } else {
      options[line.optionLabel] = (options[line.optionLabel] ?? 0) + total;
      if (accepted.has(line.optionLabel)) costPence += cost;
    }
  }
  const acceptedTotal = Object.entries(options)
    .filter(([label]) => accepted.has(label))
    .reduce((sum, [, v]) => sum + v, 0);
  return { corePence, options, totalPence: corePence + acceptedTotal, costPence };
}

/**
 * A quote must never total less than £0 (Joe, 18 Nov 2026). Minus lines are fine while the total
 * stays at or above £0, whichever optional extras the customer picks. '' when allowed, else the
 * reason in plain English (shared by the server, the screen and the demo).
 */
export function quoteBelowZeroProblem(t: Pick<QuoteTotals, 'corePence' | 'options'>): string {
  if (t.corePence < 0)
    return `A quote can’t come to less than £0. This one comes to ${formatPence(t.corePence)}: take some of the minus lines off, or add the work they’re set against.`;
  const minus = Object.entries(t.options).filter(([, v]) => v < 0);
  const lowest = t.corePence + minus.reduce((a, [, v]) => a + v, 0);
  if (lowest < 0)
    return `A quote can’t come to less than £0. With the option${minus.length > 1 ? 's' : ''} ${minus.map(([k]) => `“${k}”`).join(' and ')} it would come to ${formatPence(lowest)}.`;
  return '';
}
