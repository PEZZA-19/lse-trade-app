import { describe, expect, it } from 'vitest';
import { formToPatch } from './SettingsScreen';

const base = {
  name: 'Demo Electric',
  legalName: '',
  address: '1 Demo Lane',
  phone: '',
  email: '',
  labourRate: '45.00',
  markup: '1.3',
  quoteValidDays: '30',
  paymentTermsDays: '14',
  taxRate: '0',
  quoteTerms: '',
  invoiceTerms: '',
  bankAccountName: '',
  bankSortCode: '',
  bankAccountNumber: '',
  sequences: [{ kind: 'quote' as const, prefix: 'Q-', padding: '4', nextValue: '7' }],
};

describe('formToPatch', () => {
  it('converts pounds, markup and percentages to the API units', () => {
    const { patch, errors } = formToPatch({
      ...base,
      labourRate: '£47.50',
      markup: '1.25',
      taxRate: '0',
    });
    expect(errors).toEqual({});
    expect(patch).toMatchObject({
      labourRatePence: 4750,
      defaultMarkupBp: 12500,
      taxRateBp: 0,
      sequences: [{ kind: 'quote', prefix: 'Q-', padding: 4, nextValue: 7 }],
    });
  });

  it('flags invalid numbers instead of sending them', () => {
    const { errors } = formToPatch({
      ...base,
      labourRate: 'lots',
      markup: '0.5',
      paymentTermsDays: '2 weeks',
      sequences: [{ kind: 'job', prefix: '', padding: '0', nextValue: 'abc' }],
    });
    expect(Object.keys(errors).sort()).toEqual([
      'defaultMarkupBp',
      'labourRatePence',
      'paymentTermsDays',
      'seq.job',
    ]);
  });
});
