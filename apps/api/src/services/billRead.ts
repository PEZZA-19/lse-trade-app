/**
 * The AI fallback for bill PDFs no built-in reader knows. The browser extracts the text (pdf.js)
 * and runs the CEF/DOCI readers itself; only unknown layouts come here. The answer is checked
 * the same way as a built-in read and only ever fills in the review screen.
 */
import { finishReadBill, parseQty, type ReadBill } from '@lse/shared';
import type { Tx } from '../db/client';
import type { AiGateway } from '../ai/gateway';
import { aiBillAnswer, BILL_READ_SYSTEM } from '../ai/prompts';
import type { Auth } from '../lib/types';

export type BillReadResult =
  | { ok: true; bill: ReadBill; aiCallId: string; provider: string }
  | { ok: false; message: string; aiCallId: string | null };

export async function readBillWithAi(
  tx: Tx,
  auth: Auth,
  ai: AiGateway,
  input: { text: string; fileName: string | null },
): Promise<BillReadResult> {
  const res = await ai.run(
    tx,
    auth,
    { purpose: 'bill_read', system: BILL_READ_SYSTEM, input },
    aiBillAnswer,
  );
  if (!res.ok) return { ok: false, message: res.error, aiCallId: res.callId };
  const a = res.data;
  const bill = finishReadBill(
    {
      parser: 'ai',
      supplier: a.supplier,
      supplierLegalName: a.supplier,
      kind: a.kind,
      reference: a.reference,
      billDate: a.billDate,
      dueDate: a.dueDate,
      dueDateNote: a.dueDate ? 'Read by the AI helper' : null,
      orderNumber: a.orderNumber,
      yourReference: a.yourReference,
      accountRef: null,
      lines: a.lines.map((l) => ({
        qtyMilli: parseQty(String(Math.round(l.qty * 1000) / 1000)) ?? 1000,
        code: l.code,
        description: l.description,
        unit: null,
        unitPricePence: l.unitPricePence,
        discountBp: Math.round(l.discountPercent * 100),
        totalPence: l.totalPence,
        rrpPence: null,
      })),
      goodsPence: a.goodsPence,
      vatPence: a.vatPence,
      totalPence: a.totalPence,
      pages: [],
    },
    ['Read by the AI helper: check every line against the PDF before saving.'],
  );
  return { ok: true, bill, aiCallId: res.callId, provider: res.provider };
}
