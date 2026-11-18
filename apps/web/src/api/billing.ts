import type {
  InvoiceCreate,
  InvoiceDetailDto,
  InvoiceSummaryDto,
  InvoiceUpdate,
  JobInvoicingDto,
  KitChangeSummary,
  KitDetailDto,
  KitInput,
  KitSummaryDto,
  KitUpdate,
  PaymentCreate,
  PriceImportResultDto,
  PriceItemDetailDto,
  PriceItemDto,
  PriceItemInput,
  PriceItemUpdate,
} from '@lse/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from './client';
import { keys as baseKeys } from './hooks';

export type InvoiceFilter = 'all' | 'draft' | 'outstanding' | 'overdue' | 'paid';

export const billingKeys = {
  items: (q: string, inactive: boolean) => ['price-list', q, inactive] as const,
  item: (id: string) => ['price-item', id] as const,
  kits: ['kits'] as const,
  kit: (id: string) => ['kit', id] as const,
  invoices: (filter: InvoiceFilter) => ['invoices', filter] as const,
  invoice: (id: string) => ['invoice', id] as const,
  jobInvoicing: (jobId: string) => ['job-invoicing', jobId] as const,
};

/* ------------------------------ price list ------------------------------ */

export const usePriceList = (q = '', inactive = false) =>
  useQuery({
    queryKey: billingKeys.items(q, inactive),
    queryFn: ({ signal }) =>
      api<PriceItemDto[]>(
        'GET',
        `/price-list?${new URLSearchParams({ ...(q ? { q } : {}), ...(inactive ? { inactive: 'true' } : {}) })}`,
        undefined,
        { signal },
      ),
    placeholderData: keepPreviousData,
  });

export const usePriceItem = (id: string) =>
  useQuery({
    queryKey: billingKeys.item(id),
    queryFn: () => api<PriceItemDetailDto>('GET', `/price-list/${id}`),
    enabled: !!id,
  });

/** Any price change can move kit costs: refresh the lot. */
function invalidatePrices(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['price-list'] });
  void qc.invalidateQueries({ queryKey: ['price-item'] });
  void qc.invalidateQueries({ queryKey: billingKeys.kits });
  void qc.invalidateQueries({ queryKey: ['kit'] });
}

export function useSavePriceItem(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PriceItemInput | PriceItemUpdate) =>
      id
        ? api<PriceItemDetailDto & { kitChanges: KitChangeSummary[] }>(
            'PATCH',
            `/price-list/${id}`,
            input,
          )
        : api<PriceItemDetailDto & { kitChanges?: KitChangeSummary[] }>(
            'POST',
            '/price-list',
            input,
          ),
    onSuccess: (item) => {
      qc.setQueryData(billingKeys.item(item.id), item);
      invalidatePrices(qc);
    },
  });
}

export function useDeletePriceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>('DELETE', `/price-list/${id}`),
    onSuccess: () => invalidatePrices(qc),
  });
}

export function useImportPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { csv: string; apply: boolean }) =>
      api<PriceImportResultDto>('POST', '/price-list/import', input),
    onSuccess: (r) => r.applied && invalidatePrices(qc),
  });
}

/* --------------------------------- kits ---------------------------------- */

export const useKits = () =>
  useQuery({ queryKey: billingKeys.kits, queryFn: () => api<KitSummaryDto[]>('GET', '/kits') });

export const useKit = (id: string | null) =>
  useQuery({
    queryKey: billingKeys.kit(id ?? ''),
    queryFn: () => api<KitDetailDto>('GET', `/kits/${id}`),
    enabled: !!id,
  });

export function useSaveKit(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: KitInput | KitUpdate) =>
      id
        ? api<KitDetailDto>('PATCH', `/kits/${id}`, input)
        : api<KitDetailDto>('POST', '/kits', input),
    onSuccess: (k) => {
      qc.setQueryData(billingKeys.kit(k.id), k);
      void qc.invalidateQueries({ queryKey: billingKeys.kits });
      void qc.invalidateQueries({ queryKey: ['price-list'] });
    },
  });
}

export function useDeleteKit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>('DELETE', `/kits/${id}`),
    onSuccess: () => invalidatePrices(qc),
  });
}

/* ------------------------------- invoices -------------------------------- */

export const useInvoices = (filter: InvoiceFilter, enabled = true) =>
  useQuery({
    queryKey: billingKeys.invoices(filter),
    queryFn: () => api<InvoiceSummaryDto[]>('GET', `/invoices?filter=${filter}`),
    enabled,
    placeholderData: keepPreviousData,
  });

export const useInvoice = (id: string) =>
  useQuery({
    queryKey: billingKeys.invoice(id),
    queryFn: () => api<InvoiceDetailDto>('GET', `/invoices/${id}`),
  });

export const useJobInvoicing = (jobId: string) =>
  useQuery({
    queryKey: billingKeys.jobInvoicing(jobId),
    queryFn: () => api<JobInvoicingDto>('GET', `/jobs/${jobId}/invoicing`),
  });

function afterInvoiceChange(
  qc: ReturnType<typeof useQueryClient>,
  inv: InvoiceDetailDto | null,
  jobId: string,
) {
  if (inv) qc.setQueryData(billingKeys.invoice(inv.id), inv);
  void qc.invalidateQueries({ queryKey: ['invoices'] });
  void qc.invalidateQueries({ queryKey: billingKeys.jobInvoicing(jobId) });
}

export function useCreateInvoice(jobId: string) {
  const qc = useQueryClient();
  // One key per sheet visit: a double tap never makes two drafts.
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (input: InvoiceCreate) =>
      api<InvoiceDetailDto>('POST', `/jobs/${jobId}/invoices`, input, { idempotencyKey: key }),
    onSuccess: (inv) => {
      setKey(newIdempotencyKey());
      afterInvoiceChange(qc, inv, jobId);
    },
  });
}

export function useUpdateInvoice(inv: { id: string; jobId: string; version: number }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InvoiceUpdate) =>
      api<InvoiceDetailDto>('PATCH', `/invoices/${inv.id}`, input, { ifMatch: inv.version }),
    onSuccess: (r) => afterInvoiceChange(qc, r, inv.jobId),
  });
}

export function useDeleteInvoice(inv: { id: string; jobId: string }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('DELETE', `/invoices/${inv.id}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: billingKeys.invoice(inv.id) });
      afterInvoiceChange(qc, null, inv.jobId);
    },
  });
}

/** Approve and Mark as sent: the owner's explicit taps. */
export function useInvoiceDecision(inv: { id: string; jobId: string; version: number }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: { action: 'approve' | 'mark-sent' | 'use-credit'; useCredit?: boolean }) =>
      api<InvoiceDetailDto>(
        'POST',
        `/invoices/${inv.id}/${d.action}`,
        // Customer credit is never used silently: the approve sheet says which (Joe, 18 Nov 2026).
        d.useCredit === undefined ? undefined : { useCredit: d.useCredit },
        { ...(d.action === 'approve' ? { ifMatch: inv.version } : {}) },
      ),
    onSuccess: (r) => afterInvoiceChange(qc, r, inv.jobId),
  });
}

export function useRecordPayment(inv: { id: string; jobId: string }) {
  const qc = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (input: PaymentCreate) =>
      api<InvoiceDetailDto & { jobCompleted: boolean }>(
        'POST',
        `/invoices/${inv.id}/payments`,
        input,
        {
          idempotencyKey: key,
        },
      ),
    onSuccess: (r) => {
      setKey(newIdempotencyKey());
      afterInvoiceChange(qc, r, inv.jobId);
      // The job may have moved to Complete.
      void qc.invalidateQueries({ queryKey: baseKeys.job(inv.jobId) });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}
