import type { CreditNoteCreate, CreditNoteDto } from '@lse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from './client';
import { billingKeys } from './billing';
import { keys as baseKeys } from './hooks';

const creditKey = (id: string) => ['credit-note', id] as const;

export const useCreditNote = (id: string | null) =>
  useQuery({
    queryKey: creditKey(id ?? ''),
    queryFn: () => api<CreditNoteDto>('GET', `/credit-notes/${id}`),
    enabled: !!id,
  });

function afterChange(qc: ReturnType<typeof useQueryClient>, invoiceId: string, jobId: string) {
  void qc.invalidateQueries({ queryKey: billingKeys.invoice(invoiceId) });
  void qc.invalidateQueries({ queryKey: ['invoices'] });
  void qc.invalidateQueries({ queryKey: billingKeys.jobInvoicing(jobId) });
}

export function useCreateCreditNote(inv: { id: string; jobId: string }) {
  const qc = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (input: CreditNoteCreate) =>
      api<CreditNoteDto>('POST', `/invoices/${inv.id}/credit-notes`, input, {
        idempotencyKey: key,
      }),
    onSuccess: (cn) => {
      setKey(newIdempotencyKey());
      qc.setQueryData(creditKey(cn.id), cn);
      afterChange(qc, inv.id, inv.jobId);
    },
  });
}

/** Approve: the owner's explicit tap. Takes the CN number and reduces the invoice balance. */
export function useApproveCreditNote(cn: {
  id: string;
  version: number;
  invoiceId: string;
  jobId: string;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<CreditNoteDto & { jobCompleted: boolean }>(
        'POST',
        `/credit-notes/${cn.id}/approve`,
        undefined,
        { ifMatch: cn.version },
      ),
    onSuccess: (r) => {
      qc.setQueryData(creditKey(cn.id), r);
      afterChange(qc, cn.invoiceId, cn.jobId);
      void qc.invalidateQueries({ queryKey: baseKeys.job(cn.jobId) });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useDeleteCreditNote(cn: { id: string; invoiceId: string; jobId: string }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('DELETE', `/credit-notes/${cn.id}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: creditKey(cn.id) });
      afterChange(qc, cn.invoiceId, cn.jobId);
    },
  });
}
