/**
 * Deterministic stand-in for a model, for tests, local development and the preview. Same
 * input, same answer, no network. Its drafts are deliberately plain so nobody mistakes them
 * for a real model's.
 */
import { approxTokens, type ModelProvider, type ModelRequest, type ModelResponse } from './gateway';
import type { AiBillAnswer, EmailAnswer, QuoteAnswer } from './prompts';

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';
const pounds = (p: number) => `£${(p / 100).toFixed(2)}`;
const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function isoDate(s: string): string | null {
  let m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{4})/i.exec(s);
  if (m) return `${m[3]}-${MONTHS[m[2]!.slice(0, 3).toLowerCase()]}-${m[1]!.padStart(2, '0')}`;
  return null;
}

function readBill(input: { text: string; fileName?: string | null }): AiBillAnswer {
  const text = input.text ?? '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const ref =
    /invoice\s*(?:no\.?|number|#)?\s*:?\s*([A-Z0-9][A-Z0-9/-]{1,30})/i.exec(text)?.[1] ?? '';
  const totals = [...text.matchAll(/total[^0-9£\n]*£?\s*([\d,]+\.\d{2})/gi)];
  const last = totals[totals.length - 1]?.[1];
  const total = last ? Math.round(Number(last.replace(/,/g, '')) * 100) : null;
  return {
    supplier: (lines[0] ?? 'Unknown supplier').split(/\s{2,}/)[0]!.slice(0, 100),
    reference: ref,
    billDate: isoDate(text),
    dueDate: null,
    orderNumber: null,
    yourReference: null,
    kind: /credit note/i.test(text) ? 'credit_note' : 'bill',
    lines: total
      ? [
          {
            qty: 1,
            code: null,
            description: `Goods on ${input.fileName ?? 'this bill'} (one line: split it if needed)`,
            unitPricePence: total,
            discountPercent: 0,
            totalPence: total,
          },
        ]
      : [],
    goodsPence: total,
    vatPence: null,
    totalPence: total,
  };
}

function reply(input: { customerName: string; message: string }): EmailAnswer {
  const about = input.message
    .trim()
    .split(/[.!?\n]/)[0]!
    .slice(0, 80)
    .toLowerCase();
  return {
    subject: 'Re: your enquiry',
    body: `Hi ${first(input.customerName)},\n\nThanks for getting in touch about ${about || 'the work'}. I’d be glad to help. Could you send a couple of photos and let me know when someone will be in, so I can come and have a look and give you a proper price?`,
  };
}

function reminder(input: {
  customerName: string;
  invoiceNumber: string;
  amountPence: number;
  dueDate: string;
  daysOverdue: number;
}): EmailAnswer {
  return {
    subject: `Invoice ${input.invoiceNumber}: friendly reminder`,
    body: `Hi ${first(input.customerName)},\n\nJust a quick reminder that invoice ${input.invoiceNumber} for ${pounds(input.amountPence)} was due on ${input.dueDate}. If you’ve already paid, thank you, and please ignore this. If not, the bank details are on the invoice.\n\nAny questions, just reply here.`,
  };
}

function quote(input: {
  message: string;
  items: { id: string; description: string }[];
}): QuoteAnswer {
  const words = new Set(
    input.message
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
  const picked = input.items
    .filter((i) =>
      i.description
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((w) => w.length >= 4 && words.has(w)),
    )
    .slice(0, 5);
  return {
    title:
      input.message
        .trim()
        .split(/[.!?\n]/)[0]!
        .slice(0, 80) || 'Work from enquiry',
    lines: [
      ...picked.map((i) => ({
        itemId: i.id,
        kind: 'material' as const,
        description: i.description,
        qty: 1,
      })),
      {
        itemId: null,
        kind: 'labour' as const,
        description: 'Labour (estimate: check on site)',
        qty: 2,
      },
    ],
    notes: picked.length
      ? 'Items matched from words in the enquiry. Check quantities.'
      : 'No price-list items matched the enquiry; add materials after a site visit.',
  };
}

export class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly model = 'fake-deterministic-1';
  readonly calls: ModelRequest[] = [];

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const input = req.input as never;
    const out =
      req.purpose === 'bill_read'
        ? readBill(input)
        : req.purpose === 'reply_email'
          ? reply(input)
          : req.purpose === 'overdue_reminder'
            ? reminder(input)
            : req.purpose === 'quote_draft'
              ? quote(input)
              : {};
    const text = JSON.stringify(out);
    return {
      text,
      inputTokens: approxTokens(req.system + JSON.stringify(req.input)),
      outputTokens: approxTokens(text),
      costMillipence: 0,
    };
  }
}
