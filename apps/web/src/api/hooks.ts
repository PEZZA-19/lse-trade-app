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
  ReadinessDto,
  SettingsDto,
  SettingsUpdate,
} from '@lse/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getOutbox, NeedsAttentionError, saveJob, saveQuote } from '../offline';
import { persister } from '../offline/persist';
import { api, ApiError, newIdempotencyKey, setCsrfToken } from './client';

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

export interface SessionInfo {
  user: { id: string; name: string; email: string };
  memberships: { tenantId: string; tenantName: string; role: string }[];
  tenantId: string | null;
  role: string | null;
  csrfToken: string;
}

export const keys = {
  session: ['session'] as const,
  settings: ['settings'] as const,
  readiness: ['readiness'] as const,
  me: ['me'] as const,
  customers: (q?: string) => ['customers', q ?? ''] as const,
  customer: (id: string) => ['customer', id] as const,
  quotes: (status?: QuoteStatus, q?: string) => ['quotes', status ?? 'all', q ?? ''] as const,
  quote: (id: string) => ['quote', id] as const,
  jobs: (filter: string, q?: string) => ['jobs', filter, q ?? ''] as const,
  job: (id: string) => ['job', id] as const,
};

/** null = signed out (401). Other errors (e.g. offline) are thrown so we don't sign people out by mistake. */
export const useSession = () =>
  useQuery({
    queryKey: keys.session,
    queryFn: async () => {
      try {
        const s = await api<SessionInfo>('GET', '/auth/session');
        setCsrfToken(s.csrfToken);
        return s;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 10 * 60_000,
    retry: false,
  });

export const useRequestLink = () =>
  useMutation({
    mutationFn: (email: string) =>
      api<{ ok: true; message: string }>('POST', '/auth/request-link', { email }),
  });

export const useVerifyLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api<{ csrfToken: string }>('POST', '/auth/verify', { token }),
    onSuccess: (r) => {
      setCsrfToken(r.csrfToken);
      qc.clear();
    },
  });
};

export const useSignOut = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api<void>('POST', '/auth/logout');
      // Nothing from this business stays on the device after signing out.
      await getOutbox().clear();
      await persister.removeClient();
    },
    onSuccess: () => {
      setCsrfToken(null);
      // Drop every cached record so nothing from this business stays on screen.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      qc.setQueryData(keys.session, null);
    },
  });
};

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => api<SettingsDto>('GET', '/settings') });

export const useReadiness = () =>
  useQuery({
    queryKey: keys.readiness,
    queryFn: () => api<ReadinessDto>('GET', '/settings/readiness'),
  });

export const useUpdateSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsUpdate) => api<SettingsDto>('PATCH', '/settings', input),
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s);
      void qc.invalidateQueries({ queryKey: keys.readiness });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
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
    // Through the outbox: on the device first, then the server (cache updates when it confirms).
    mutationFn: (patch: QuotePatch) => saveQuote(id, { ...patch }),
    onSuccess: (result) => {
      if (result === 'synced') void qc.invalidateQueries({ queryKey: ['quotes'] });
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
 * Status change: the list updates instantly and the change is written to the device (outbox).
 * Resolves 'synced' once the server confirmed, or 'queued' if it will sync later. Rolls back
 * only if it couldn't even be stored on the device.
 */
export function useSetJobStatus() {
  const qc = useQueryClient();
  return useMutation({
    // Through the outbox: saved on the device first, so it works with no signal.
    mutationFn: async ({ id, status }: { id: string; status: JobStatus }) => {
      await qc.cancelQueries({ queryKey: ['jobs'] });
      const snapshots = qc.getQueriesData<Page<JobSummaryDto>>({ queryKey: ['jobs'] });
      const detail = qc.getQueryData<JobDetailDto>(keys.job(id));
      const showLocally = () => {
        for (const [key, data] of snapshots) {
          if (!data) continue;
          qc.setQueryData<Page<JobSummaryDto>>(key, {
            ...data,
            items: data.items.map((j) => (j.id === id ? { ...j, status } : j)),
          });
        }
        if (detail) qc.setQueryData<JobDetailDto>(keys.job(id), { ...detail, status });
      };
      try {
        return await saveJob(id, { status }, showLocally);
      } catch (e) {
        // Stored on the device but needs a decision: keep showing it (the Sync screen explains).
        if (!(e instanceof NeedsAttentionError)) {
          for (const [key, data] of snapshots) qc.setQueryData(key, data);
          if (detail) qc.setQueryData(keys.job(id), detail);
        }
        throw e;
      }
    },
    onSettled: (result) => {
      if (result === 'synced') void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}
