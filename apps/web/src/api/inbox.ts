import type {
  EnquiryConvert,
  EnquiryCreate,
  EnquiryDto,
  EnquiryFormDto,
  ProposalCountsDto,
  ProposalDto,
  ProposalEdit,
} from '@lse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from './client';

export const inboxKeys = {
  enquiries: (which: 'todo' | 'done') => ['enquiries', which] as const,
  enquiry: (id: string) => ['enquiry', id] as const,
  enquiryCounts: ['enquiries', 'counts'] as const,
  proposals: (which: 'open' | 'done') => ['proposals', which] as const,
  proposal: (id: string) => ['proposal', id] as const,
  proposalCounts: ['proposals', 'counts'] as const,
  form: ['enquiry-form'] as const,
};

export const useEnquiries = (which: 'todo' | 'done') =>
  useQuery({
    queryKey: inboxKeys.enquiries(which),
    queryFn: () => api<EnquiryDto[]>('GET', `/enquiries?status=${which}`),
  });
export const useEnquiry = (id: string) =>
  useQuery({
    queryKey: inboxKeys.enquiry(id),
    queryFn: () => api<EnquiryDto>('GET', `/enquiries/${id}`),
  });
export const useEnquiryCounts = () =>
  useQuery({
    queryKey: inboxKeys.enquiryCounts,
    queryFn: () => api<{ todo: number }>('GET', '/enquiries/counts'),
  });

function afterEnquiry(qc: ReturnType<typeof useQueryClient>, e?: EnquiryDto) {
  if (e) qc.setQueryData(inboxKeys.enquiry(e.id), e);
  void qc.invalidateQueries({ queryKey: ['enquiries'] });
  void qc.invalidateQueries({ queryKey: ['proposals'] });
}

export function useCreateEnquiry() {
  const qc = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (input: EnquiryCreate) =>
      api<EnquiryDto>('POST', '/enquiries', input, { idempotencyKey: key }),
    onSuccess: (e) => {
      setKey(newIdempotencyKey());
      afterEnquiry(qc, e);
    },
  });
}

export function useEnquiryAction(e: { id: string; version: number }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      a:
        | { kind: 'actioned' }
        | { kind: 'reject'; reason: string | null }
        | { kind: 'convert'; input: EnquiryConvert },
    ) =>
      a.kind === 'actioned'
        ? api<EnquiryDto>('POST', `/enquiries/${e.id}/actioned`, {}, { ifMatch: e.version })
        : a.kind === 'reject'
          ? api<EnquiryDto>(
              'POST',
              `/enquiries/${e.id}/reject`,
              { reason: a.reason },
              { ifMatch: e.version },
            )
          : api<EnquiryDto>('POST', `/enquiries/${e.id}/convert`, a.input, { ifMatch: e.version }),
    onSuccess: (r) => {
      afterEnquiry(qc, r);
      void qc.invalidateQueries({ queryKey: ['quotes'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['appointments'] });
    },
  });
}

/** AI helpers: each makes a draft in Approvals, nothing else. */
export function useDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) =>
      api<ProposalDto | { created: ProposalDto[]; skipped: string[] }>('POST', path, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['proposals'] }),
  });
}

export const useProposals = (which: 'open' | 'done') =>
  useQuery({
    queryKey: inboxKeys.proposals(which),
    queryFn: () => api<ProposalDto[]>('GET', `/proposals?status=${which}`),
    // Held emails count down; refresh so a released one shows its outcome.
    refetchInterval: (q) => (q.state.data?.some((p) => p.status === 'held') ? 5000 : false),
  });
export const useProposal = (id: string) =>
  useQuery({
    queryKey: inboxKeys.proposal(id),
    queryFn: () => api<ProposalDto>('GET', `/proposals/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'held' ? 5000 : false),
  });
export const useProposalCounts = () =>
  useQuery({
    queryKey: inboxKeys.proposalCounts,
    queryFn: () => api<ProposalCountsDto>('GET', '/proposals/counts'),
  });

export function useDecide(p: { id: string; version: number }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      d:
        | { kind: 'approve' }
        | { kind: 'stop' }
        | { kind: 'discard' }
        | { kind: 'edit'; patch: ProposalEdit },
    ) =>
      d.kind === 'edit'
        ? api<ProposalDto>('PATCH', `/proposals/${p.id}`, d.patch, { ifMatch: p.version })
        : api<ProposalDto>(
            'POST',
            `/proposals/${p.id}/${d.kind}`,
            {},
            d.kind === 'stop' ? {} : { ifMatch: p.version },
          ),
    onSuccess: (r) => {
      qc.setQueryData(inboxKeys.proposal(r.id), r);
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      void qc.invalidateQueries({ queryKey: ['enquiries'] });
      void qc.invalidateQueries({ queryKey: ['quotes'] });
      void qc.invalidateQueries({ queryKey: ['bills'] });
      void qc.invalidateQueries({ queryKey: ['price-list'] });
    },
  });
}

export const useEnquiryForm = () =>
  useQuery({
    queryKey: inboxKeys.form,
    queryFn: () => api<EnquiryFormDto>('GET', '/settings/enquiry-form'),
  });
export function useSetEnquiryForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => api<EnquiryFormDto>('POST', '/settings/enquiry-form', { on }),
    onSuccess: (r) => qc.setQueryData(inboxKeys.form, r),
  });
}
