import type { CalendarFeedDto } from '@lse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

const key = ['calendar-feeds'] as const;

export const useCalendarFeeds = (enabled = true) =>
  useQuery({
    queryKey: key,
    queryFn: () => api<CalendarFeedDto[]>('GET', '/calendar-feeds'),
    enabled,
  });

/** Makes the link, or replaces it (the old one stops working). */
export function useRegenerateFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope: CalendarFeedDto['scope']) =>
      api<CalendarFeedDto>('POST', `/calendar-feeds/${scope}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

export function useRevokeFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope: CalendarFeedDto['scope']) =>
      api<CalendarFeedDto[]>('DELETE', `/calendar-feeds/${scope}`),
    onSuccess: (feeds) => qc.setQueryData(key, feeds),
  });
}
