import type { JobDetailDto, QuoteDetailDto, QuoteLineInput } from '@lse/shared';

/** The editable fields of a record, in the same shape the PATCH endpoints accept. */
export type Fields = Record<string, unknown>;
export type Entity = 'job' | 'quote';

export const quoteLinesToInput = (q: QuoteDetailDto): QuoteLineInput[] =>
  q.current.lines.map((l) => ({
    kind: l.kind,
    description: l.description,
    qtyMilli: l.qtyMilli,
    unitCostPence: l.unitCostPence,
    markupBp: l.markupBp,
    unitPricePence: l.unitPricePence,
    optionLabel: l.optionLabel,
    taxRateBp: l.taxRateBp,
  }));

/** Reads the editable fields from a server record so offline edits can be compared with it. */
export function editableFields(entity: Entity, record: unknown): Fields {
  if (entity === 'job') {
    const j = record as JobDetailDto;
    return {
      title: j.title,
      description: j.description,
      stageId: j.stage.id,
      placeOfWork: j.placeOfWork,
      siteId: j.siteId,
    };
  }
  const q = record as QuoteDetailDto;
  return {
    title: q.title,
    notes: q.current.notes,
    validDays: q.current.validDays,
    siteId: q.siteId,
    lines: quoteLinesToInput(q),
  };
}

const LINE_KEYS = [
  'kind',
  'description',
  'qtyMilli',
  'unitCostPence',
  'markupBp',
  'unitPricePence',
  'optionLabel',
  'taxRateBp',
];

/** Canonical form for comparison: missing/undefined/"" become null, line objects keep known keys in order. */
function canonical(v: unknown): unknown {
  if (v === undefined || v === '') return null;
  if (Array.isArray(v)) {
    return v.map((x) =>
      x && typeof x === 'object'
        ? Object.fromEntries(
            LINE_KEYS.map((k) => {
              const val = (x as Record<string, unknown>)[k];
              // Defaults the server fills in, so a fresh line equals its saved copy.
              if (k === 'qtyMilli' && val == null) return [k, 1000];
              if (k === 'taxRateBp' && val == null) return [k, 0];
              return [k, canonical(val)];
            }),
          )
        : canonical(x),
    );
  }
  return v;
}

export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
