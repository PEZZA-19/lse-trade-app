export type ReportKind =
  | 'profit-and-loss'
  | 'balance-sheet'
  | 'aged-receivables'
  | 'aged-payables'
  | 'cash-flow'
  | 'tax'
  | 'budget'
  | 'transactions';

export const REPORTS: {
  kind: ReportKind;
  title: string;
  sub: string;
  glyph: string;
  colour: string;
}[] = [
  {
    kind: 'profit-and-loss',
    title: 'Profit and Loss',
    sub: 'Income, costs and profit for a period',
    glyph: '£',
    colour: 'var(--green)',
  },
  {
    kind: 'balance-sheet',
    title: 'Balance Sheet',
    sub: 'What the business has and owes on a date',
    glyph: '⚖',
    colour: 'var(--indigo)',
  },
  {
    kind: 'aged-receivables',
    title: 'Aged Receivables',
    sub: 'Who owes you, and for how long',
    glyph: '↓',
    colour: 'var(--accent)',
  },
  {
    kind: 'aged-payables',
    title: 'Aged Payables',
    sub: 'Who you owe, and for how long',
    glyph: '↑',
    colour: 'var(--orange)',
  },
  {
    kind: 'cash-flow',
    title: 'Cash Flow',
    sub: 'Money in and out of the bank by month',
    glyph: '⇅',
    colour: 'var(--teal)',
  },
  {
    kind: 'tax',
    title: 'Tax Summary',
    sub: 'GST or VAT charged (none on Sark today)',
    glyph: '%',
    colour: 'var(--pink)',
  },
  {
    kind: 'budget',
    title: 'Budget vs Actual',
    sub: 'How the year is going against plan',
    glyph: '◎',
    colour: 'var(--purple)',
  },
  {
    kind: 'transactions',
    title: 'Account Transactions',
    sub: 'Every entry in one account',
    glyph: '≡',
    colour: 'var(--label-2)',
  },
];
