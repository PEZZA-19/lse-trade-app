import type {
  CalendarActivityDto,
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
const activityKey = ['calendar-sync', 'activity'] as const;

export const useCalendarSync = (enabled = true) =>
  useQuery({
    queryKey: syncKey,
    queryFn: () => api<CalendarSyncStatusDto>('GET', '/calendar-sync'),
    enabled,
  });

/** Starts the sign-in with Google (says so plainly when it isn't set up yet). */
export function useConnectCalendar() {
  return useMutation({
    mutationFn: (provider: CalendarProvider) =>
      api<{ url: string }>('POST', `/calendar-sync/connect/${provider}`),
    onSuccess: (r) => {
      if (r?.url) window.location.assign(r.url);
    },
  });
}

export function useRunCalendarSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<CalendarSyncResultDto>('POST', '/calendar-sync/run'),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: syncKey });
      void qc.invalidateQueries({ queryKey: activityKey });
      // Moves and deletes from Google change appointments straight away.
      if (r.applied) {
        void qc.invalidateQueries({ queryKey: ['jobs'] });
        void qc.invalidateQueries({ queryKey: ['schedule'] });
      }
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

/** Moves and deletes made in Google Calendar, applied straight away (newest first). */
export const useCalendarActivity = (enabled = true) =>
  useQuery({
    queryKey: activityKey,
    queryFn: () => api<CalendarActivityDto[]>('GET', '/calendar-sync/activity'),
    enabled,
  });

export function useUndoCalendarChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<CalendarActivityDto>('POST', `/calendar-sync/activity/${id}/undo`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar-sync'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['schedule'] });
    },
  });
}
