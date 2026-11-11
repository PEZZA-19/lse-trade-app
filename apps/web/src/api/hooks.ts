import type {
  CustomerCreate,
  CustomerDetailDto,
  CustomerDto,
  JobCreate,
  JobDetailDto,
  JobStatus,
  JobSummaryDto,
  Page,
  QuoteCreate,
  QuoteDetailDto,
  QuoteLineInput,
  QuoteStatus,
  QuoteSummaryDto,
} from '@lse/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from './client';

export interface Me {
  user: { id: string; name: string; email: string };
  tenant: {
    id: string;
    name: string;
    defaultMarkupBp: number;
    labourRatePence: number;
    quoteValidDays: number;
  };
  role: string;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const keys = {
  me: ['me'] as const,
  customers: (q?: string) => ['customers', q ?? ''] as const,
  customer: (id: string) => ['customer', id] as const,
  quotes: (status?: QuoteStatus, q?: string) => ['quotes', status ?? 'all', q ?? ''] as const,
  quote: (id: string) => ['quote', id] as const,
  jobs: (filter: string, q?: string) => ['jobs', filter, q ?? ''] as const,
  job: (id: string) => ['job', id] as const,
};

export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: () => api<Me>('GET', '/me'), staleTime: 5 * 60_000 });

export const useCustomers = (q?: string) =>
  useQuery({
    queryKey: keys.customers(q),
    queryFn: ({ signal }) =>
      api<Page<CustomerDto>>('GET', `/customers${qs({ q, limit: 200 })}`, undefined, { signal }),
    placeholderData: keepPreviousData,
  });

export const useCustomer = (id: string) =>
  useQuery({
    queryKey: keys.customer(id),
    queryFn: () => api<CustomerDetailDto>('GET', `/customers/${id}`),
    enabled: !!id,
  });

export const useQuotes = (status?: QuoteStatus, q?: string) =>
  useQuery({
    queryKey: keys.quotes(status, q),
    queryFn: ({ signal }) =>
      api<Page<QuoteSummaryDto>>('GET', `/quotes${qs({ status, q, limit: 100 })}`, undefined, {
        signal,
      }),
    placeholderData: keepPreviousData,
  });

export const useQuote = (id: string) =>
  useQuery({
    queryKey: keys.quote(id),
    queryFn: () => api<QuoteDetailDto>('GET', `/quotes/${id}`),
  });

export const useJobs = (filter: 'active' | 'all', q?: string) =>
  useQuery({
    queryKey: keys.jobs(filter, q),
    queryFn: ({ signal }) =>
      api<Page<JobSummaryDto>>(
        'GET',
        `/jobs${qs({ active: filter === 'active' ? true : undefined, q, limit: 100 })}`,
        undefined,
        { signal },
      ),
    placeholderData: keepPreviousData,
  });

export const useJob = (id: string) =>
  useQuery({ queryKey: keys.job(id), queryFn: () => api<JobDetailDto>('GET', `/jobs/${id}`) });

/* -------------------------------- mutations -------------------------------- */

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerCreate) => api<CustomerDetailDto>('POST', '/customers', input),
    onSuccess: (c) => {
      qc.setQueryData(keys.customer(c.id), c);
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useCreateQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: QuoteCreate) => api<QuoteDetailDto>('POST', '/quotes', input),
    onSuccess: (q) => {
      qc.setQueryData(keys.quote(q.id), q);
      void qc.invalidateQueries({ queryKey: ['quotes'] });
      void qc.invalidateQueries({ queryKey: keys.customer(q.customerId) });
    },
  });
}

export interface QuotePatch {
  title?: string;
  notes?: string | null;
  validDays?: number;
  siteId?: string | null;
  lines?: QuoteLineInput[];
}

export function useUpdateQuote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['quote-save', id],
    mutationFn: (patch: QuotePatch) => api<QuoteDetailDto>('PATCH', `/quotes/${id}`, patch),
    onSuccess: (q) => {
      qc.setQueryData(keys.quote(id), q);
      void qc.invalidateQueries({ queryKey: ['quotes'] });
    },
  });
}

type QuoteAction = 'send' | 'revise' | 'decline' | 'accept';
export function useQuoteAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      action,
      acceptedOptions,
    }: {
      action: QuoteAction;
      acceptedOptions?: string[];
    }) =>
      api<QuoteDetailDto>(
        'POST',
        `/quotes/${id}/${action}`,
        action === 'accept' ? { acceptedOptions: acceptedOptions ?? [] } : undefined,
      ),
    onSuccess: (q) => {
      qc.setQueryData(keys.quote(id), q);
      void qc.invalidateQueries({ queryKey: ['quotes'] });
      void qc.invalidateQueries({ queryKey: keys.customer(q.customerId) });
    },
  });
}

export function useConvertQuote(id: string) {
  const qc = useQueryClient();
  // One key per screen visit: a double tap or retry can never create two jobs.
  const [key] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: () =>
      api<JobDetailDto>('POST', `/quotes/${id}/convert`, undefined, { idempotencyKey: key }),
    onSuccess: (job) => {
      qc.setQueryData(keys.job(job.id), job);
      void qc.invalidateQueries({ queryKey: keys.quote(id) });
      void qc.invalidateQueries({ queryKey: ['quotes'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: keys.customer(job.customerId) });
    },
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: JobCreate) => api<JobDetailDto>('POST', '/jobs', input),
    onSuccess: (j) => {
      qc.setQueryData(keys.job(j.id), j);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: keys.customer(j.customerId) });
    },
  });
}

/**
 * Optimistic status change: the list updates instantly, but the row is marked "Saving…"
 * until the server confirms. On failure it rolls back and the caller shows an error.
 */
export function useSetJobStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: JobStatus }) =>
      api<JobDetailDto>('PATCH', `/jobs/${id}`, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ['jobs'] });
      const snapshots = qc.getQueriesData<Page<JobSummaryDto>>({ queryKey: ['jobs'] });
      for (const [key, data] of snapshots) {
        if (!data) continue;
        qc.setQueryData<Page<JobSummaryDto>>(key, {
          ...data,
          items: data.items.map((j) => (j.id === id ? { ...j, status } : j)),
        });
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (job) => qc.setQueryData(keys.job(job.id), job),
    onSettled: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}
