import { readBillToCreate, readPdfPages } from '@lse/shared';
import { extractPdfPages } from '@lse/shared/pdftext';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { AiGateway } from '../src/ai/gateway';
import { FakeProvider } from '../src/ai/fake';
import { cefPdf } from '../../../packages/shared/test/fixtures/bill-pdfs';
import { client, fakeAi, mailer } from './api-helpers';
import { adminSql, appSql } from './helpers';
import { DEFAULT_ORIGIN, signIn } from '../src/dev/session-client';

describe('bills read from PDFs', () => {
  it('saves a CEF read as a draft with merchant rounding and the due date', async () => {
    const c = await client();
    const r = readPdfPages(await extractPdfPages(await cefPdf()));
    if (r.kind !== 'bills') throw new Error(r.kind);
    const draft = readBillToCreate(r.bills[1]!, { fileName: 'cef.pdf' });
    const res = await c.req('POST', '/api/supplier-bills', draft);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      supplierName: 'CEF',
      reference: 'GUR/900102',
      source: 'pdf',
      dueDate: '2026-12-07',
      totalPence: 1690,
      status: 'draft',
    });
    expect(res.body.lines.map((l: { totalPence: number }) => l.totalPence)).toEqual([
      799, 455, 436,
    ]);
  });

  it('rejects a printed line total that is not qty × cost', async () => {
    const c = await client();
    const res = await c.req('POST', '/api/supplier-bills', {
      supplier: 'CEF',
      reference: 'X1',
      billDate: '2026-11-07',
      lines: [{ description: 'Cells', qtyMilli: 10000, unitCostPence: 46, totalPence: 300 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.fields['lines.0.totalPence']).toBeTruthy();
  });

  it('drafts unknown layouts with the AI helper, logs the call, and saves nothing', async () => {
    const c = await client();
    const before = fakeAi.calls.length;
    const res = await c.req('POST', '/api/supplier-bills/read', {
      text: 'Corner Shop Ltd\nInvoice No: CS-42\nDate 03/11/2026\nTotal £9.99',
      fileName: 'corner.pdf',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.provider).toBe('fake');
    expect(res.body.bill).toMatchObject({
      parser: 'ai',
      supplier: 'Corner Shop Ltd',
      reference: 'CS-42',
      billDate: '2026-11-03',
      totalPence: 999,
      adds: false,
    });
    expect(res.body.bill.problems[0]).toMatch(/AI helper: check every line/);
    expect(fakeAi.calls.length).toBe(before + 1);
    const [log] =
      await adminSql`SELECT purpose, provider, status, prompt, response FROM ai_calls WHERE id = ${res.body.aiCallId}`;
    expect(log).toMatchObject({ purpose: 'bill_read', provider: 'fake', status: 'ok' });
    expect(log!.prompt).toContain('Corner Shop Ltd');
    expect(log!.response).toContain('CS-42');
    const bills = await c.req('GET', '/api/supplier-bills');
    expect(bills.body).toHaveLength(0);
  });

  it('says so when the AI helper is off or over its cap, and logs the refusal', async () => {
    const off = createApp({ getSql: () => appSql, auth: { mailer, appOrigin: DEFAULT_ORIGIN } });
    const capped = createApp({
      getSql: () => appSql,
      auth: { mailer, appOrigin: DEFAULT_ORIGIN },
      ai: new AiGateway(new FakeProvider(), 0),
    });
    const c = await client();
    for (const [app, message] of [
      [off, /not switched on/],
      [capped, /spend cap/],
    ] as const) {
      const s = await signIn(app, mailer, c.email);
      const res = await s.request('POST', '/api/supplier-bills/read', { text: 'Some invoice' });
      const body = (await res.json()) as { ok: boolean; message: string };
      expect(body.ok).toBe(false);
      expect(body.message).toMatch(message);
    }
    const rows = await adminSql`SELECT status FROM ai_calls WHERE tenant_id = ${c.tenantId}`;
    expect(rows.map((r) => r.status)).toEqual(['refused']);
  });
});
