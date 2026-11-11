/** Kinds of document number each business allocates from its own sequence. */
export const SEQUENCE_KINDS = ['quote', 'job', 'invoice', 'credit_note'] as const;
export type SequenceKind = (typeof SEQUENCE_KINDS)[number];

/** formatDocNumber('Q-', 4, 1) -> "Q-0001"; formatDocNumber('', 0, 122) -> "122" */
export function formatDocNumber(prefix: string, padding: number, value: number): string {
  return `${prefix}${String(value).padStart(padding, '0')}`;
}

/** 1 -> "A", 2 -> "B", 26 -> "Z", 27 -> "AA" (spreadsheet-style). */
export function revisionLetter(revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) throw new RangeError('revision must be >= 1');
  let n = revision;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "Q-0012", 2 -> "Q-0012 rev B" (rev A is shown without a suffix). */
export function quoteDisplayNumber(number: string, revision: number): string {
  return revision > 1 ? `${number} rev ${revisionLetter(revision)}` : number;
}
