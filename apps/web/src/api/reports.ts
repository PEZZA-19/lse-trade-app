import type { ReportsDto } from '@lse/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export const useReports = (from: string, to: string, enabled = true) =>
  useQuery({
    queryKey: ['reports', from, to],
    queryFn: () => api<ReportsDto>('GET', `/reports?${new URLSearchParams({ from, to })}`),
    enabled,
  });
