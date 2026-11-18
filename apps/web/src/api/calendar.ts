import type {
  CalendarFeedDto,
  CalendarProvider,
  CalendarSyncResultDto,
  CalendarSyncStatusDto,
} from '@lse/shared';
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

/* --------------------------- two-way calendar sync ------------------------- */

const syncKey = ['calendar-sync'] as const;

export const useCalendarSync = (enabled = true) =>
  useQuery({
    queryKey: syncKey,
    queryFn: () => api<CalendarSyncStatusDto>('GET', '/calendar-sync'),
    enabled,
  });

/** Starts the sign-in with Google or Microsoft (says so plainly when it isn't set up yet). */
export function useConnectCalendar() {
  return useMutation({
    mutationFn: (provider: CalendarProvider) =>
      api<{ redirect: string }>('POST', `/calendar-sync/connect/${provider}`),
    onSuccess: (r) => {
      if (r?.redirect) window.location.assign(r.redirect);
    },
  });
}

export function useRunCalendarSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<CalendarSyncResultDto>('POST', '/calendar-sync/run'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: syncKey });
      void qc.invalidateQueries({ queryKey: ['proposals'] });
    },
  });
}

export function useDisconnectCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<null>('DELETE', `/calendar-sync/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: syncKey }),
  });
}
