import { lineTotal, sellFromCost, type Pence } from './money';

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

export function pricedLineTotal(line: PricedLineInput, defaults: PricingDefaults): Pence {
  return lineTotal(line.qtyMilli, unitSell(line, defaults));
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
    const cost = line.unitCostPence != null ? lineTotal(line.qtyMilli, line.unitCostPence) : 0;
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
