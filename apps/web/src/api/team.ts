import type {
  AccessArea,
  JobCostingDto,
  MemberAccessDto,
  MemberCostUpdate,
  TeamMemberDto,
} from '@lse/shared';
import { keys } from './hooks';
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

/** Admins only: who can see what. */
export const useAccessList = (enabled = true) =>
  useQuery({
    queryKey: ['team-access'],
    queryFn: () => api<MemberAccessDto[]>('GET', '/team/access'),
    enabled,
  });

export function useSetAccess(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { isAdmin: boolean; areas: AccessArea[] }) =>
      api<MemberAccessDto>('PUT', `/team/${userId}/access`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team-access'] });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}
