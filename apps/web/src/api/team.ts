import type { JobCostingDto, MemberCostUpdate, TeamMemberDto } from '@lse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export const useTeam = (enabled = true) =>
  useQuery({
    queryKey: ['team'],
    queryFn: () => api<TeamMemberDto[]>('GET', '/team'),
    enabled,
  });

export function useSetMemberCost(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MemberCostUpdate) =>
      api<TeamMemberDto>('PUT', `/team/${userId}/cost`, input),
    onSuccess: () => {
      for (const k of ['team', 'reports', 'job-costing'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export const useJobCosting = (jobId: string, enabled = true) =>
  useQuery({
    queryKey: ['job-costing', jobId],
    queryFn: () => api<JobCostingDto>('GET', `/jobs/${jobId}/costing`),
    enabled,
  });

export function useSetChargeOut(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chargeOutPence: number | null) =>
      api<TeamMemberDto>('PUT', `/team/${userId}/charge-out`, { chargeOutPence }),
    onSuccess: () => {
      for (const k of ['team', 'reports', 'job-costing', 'job-invoicing'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}
