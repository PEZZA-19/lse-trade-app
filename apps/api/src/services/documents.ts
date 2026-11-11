import { invoiceDocument, quoteDocument, type BusinessDocument } from '@lse/shared';
import { renderPdf } from '@lse/shared/pdf';
import type { Tx } from '../db/client';
import { getInvoice, today } from './invoices';
import { getQuote } from './quotes';
import { getSettings } from './settings';

/** The invoice as laid out on paper (same model the app previews). */
export async function invoiceDoc(tx: Tx, id: string): Promise<BusinessDocument> {
  const inv = await getInvoice(tx, id);
  const [job] = await tx<{ siteAddress: string | null }[]>`
    SELECT s.address AS site_address FROM jobs j LEFT JOIN sites s ON s.id = j.site_id WHERE j.id = ${inv.jobId}`;
  return invoiceDocument(inv, await getSettings(tx), { siteAddress: job?.siteAddress ?? null });
}

/** The current revision of a quote, addressed to the bill payer if there is one. */
export async function quoteDoc(tx: Tx, id: string): Promise<BusinessDocument> {
  const q = await getQuote(tx, id);
  const [c] = await tx<
    {
      name: string;
      email: string | null;
      address: string | null;
      contactName: string | null;
      contactEmail: string | null;
    }[]
  >`
    SELECT c.name, c.email, c.billing_address AS address, bp.name AS contact_name, bp.email AS contact_email
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT name, email FROM contacts WHERE customer_id = c.id AND role = 'bill_payer'
         ORDER BY (email IS NULL), created_at LIMIT 1) bp ON true
     WHERE c.id = ${q.customerId}`;
  // Same rule as invoices: a bill payer with an email is who the document is addressed to.
  const to = c!.contactEmail
    ? { name: `${c!.contactName} (${c!.name})`, email: c!.contactEmail, address: c!.address }
    : { name: c!.name, email: c!.email, address: c!.address };
  return quoteDocument(q, await getSettings(tx), to, await today(tx));
}

export const pdfOf = renderPdf;
