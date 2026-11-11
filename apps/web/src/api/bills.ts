import type {
  BillApplyResultDto,
  BillCreate,
  BillDetailDto,
  BillSummaryDto,
  BillUpdate,
  SupplierDto,
  SupplierInput,
  SupplierUpdate,
} from '@lse/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from './client';

export type BillFilter = 'draft' | 'applied' | 'all';

export const billKeys = {
  suppliers: ['suppliers'] as const,
  supplier: (id: string) => ['supplier', id] as const,
  bills: (filter: BillFilter, supplierId?: string) => ['bills', filter, supplierId ?? ''] as const,
  bill: (id: string) => ['bill', id] as const,
};

export const useSuppliers = () =>
  useQuery({
    queryKey: billKeys.suppliers,
    queryFn: () => api<SupplierDto[]>('GET', '/suppliers'),
  });

export const useSupplier = (id: string) =>
  useQuery({
    queryKey: billKeys.supplier(id),
    queryFn: () => api<SupplierDto>('GET', `/suppliers/${id}`),
  });

export function useSaveSupplier(s?: { id: string; version: number }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SupplierInput | SupplierUpdate) =>
      s
        ? api<SupplierDto>('PATCH', `/suppliers/${s.id}`, input, { ifMatch: s.version })
        : api<SupplierDto>('POST', '/suppliers', input),
    onSuccess: (r) => {
      qc.setQueryData(billKeys.supplier(r.id), r);
      void qc.invalidateQueries({ queryKey: billKeys.suppliers });
      void qc.invalidateQueries({ queryKey: ['bills'] });
      void qc.invalidateQueries({ queryKey: ['price-list'] });
    },
  });
}

export const useBills = (filter: BillFilter, supplierId?: string, enabled = true) =>
  useQuery({
    queryKey: billKeys.bills(filter, supplierId),
    queryFn: () =>
      api<BillSummaryDto[]>(
        'GET',
        `/supplier-bills?${new URLSearchParams({
          ...(filter !== 'all' ? { status: filter } : {}),
          ...(supplierId ? { supplierId } : {}),
        })}`,
      ),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useBill = (id: string) =>
  useQuery({
    queryKey: billKeys.bill(id),
    queryFn: () => api<BillDetailDto>('GET', `/supplier-bills/${id}`),
  });

function afterBillChange(qc: ReturnType<typeof useQueryClient>, b: BillDetailDto | null) {
  if (b) qc.setQueryData(billKeys.bill(b.id), b);
  void qc.invalidateQueries({ queryKey: ['bills'] });
  void qc.invalidateQueries({ queryKey: billKeys.suppliers });
}

export function useCreateBill() {
  const qc = useQueryClient();
  // One key per sheet visit: a double tap never enters the bill twice.
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (input: BillCreate) =>
      api<BillDetailDto>('POST', '/supplier-bills', input, { idempotencyKey: key }),
    onSuccess: (b) => {
      setKey(newIdempotencyKey());
      afterBillChange(qc, b);
    },
  });
}

export function useUpdateBill(b: { id: string; version: number }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BillUpdate) =>
      api<BillDetailDto>('PATCH', `/supplier-bills/${b.id}`, input, { ifMatch: b.version }),
    onSuccess: (r) => afterBillChange(qc, r),
  });
}

export function useDeleteBill(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('DELETE', `/supplier-bills/${id}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: billKeys.bill(id) });
      afterBillChange(qc, null);
    },
  });
}

/** Preview (dryRun) changes nothing; the real apply is a separate, explicit owner tap. */
export function useApplyBill(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) =>
      api<BillApplyResultDto>('POST', `/supplier-bills/${id}/apply`, { dryRun }),
    onSuccess: (r) => {
      if (!r.applied) return;
      void qc.invalidateQueries({ queryKey: billKeys.bill(id) });
      afterBillChange(qc, null);
      // Prices, kits and job costs may all have moved.
      for (const k of ['price-list', 'price-item', 'kits', 'kit', 'jobs', 'job', 'job-invoicing'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}
