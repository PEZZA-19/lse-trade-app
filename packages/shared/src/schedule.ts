import { z } from 'zod';
import type { JobStageRef } from './stages';

/* ------------------------------- inputs ------------------------------- */

const isoTime = z.iso.datetime({ offset: true });

export const appointmentUpdate = z
  .object({ startsAt: isoTime, endsAt: isoTime, userId: z.uuid().nullish() })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'The end must be after the start',
    path: ['endsAt'],
  });
export type AppointmentUpdate = z.input<typeof appointmentUpdate>;

export const appointmentRange = z
  .object({ from: isoTime, to: isoTime })
  .refine((v) => new Date(v.to) > new Date(v.from), { message: '`to` must be after `from`' })
  .refine((v) => +new Date(v.to) - +new Date(v.from) <= 62 * 86_400_000, {
    message: 'Ask for at most about two months at a time',
  });

/**
 * Timer start/stop. `at` is when it happened on the device (so a timer started with no signal keeps
 * its real start time). `switch` on start stops a timer running on another job first.
 */
export const timerAction = z.object({ at: isoTime.optional(), switch: z.boolean().optional() });
export type TimerAction = z.input<typeof timerAction>;

/** How far a device clock may be trusted for `at`: up to 7 days back, 5 minutes ahead. */
export const TIMER_MAX_BACKDATE_MS = 7 * 86_400_000;
export const TIMER_MAX_AHEAD_MS = 5 * 60_000;

/* -------------------------------- DTOs -------------------------------- */

export interface MemberDto {
  userId: string;
  name: string;
  role: string;
}

/** An appointment with enough of its job to draw it on the calendar. */
export interface AppointmentListItemDto {
  id: string;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  customerName: string;
  siteAddress: string | null;
  stage: JobStageRef;
  startsAt: string;
  endsAt: string;
  userId: string | null;
  userName: string | null;
}

export interface TimesheetDto {
  id: string;
  userId: string;
  userName: string;
  startedAt: string;
  endedAt: string;
  minutes: number;
  source: 'timer' | 'manual';
  note: string | null;
  /** Already on an invoice: fixed from then on. */
  invoiced: boolean;
}

export interface RunningTimerDto {
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  startedAt: string;
}

/** Whole minutes, rounded to the nearest (a 20-second timer is 0 min, not 1). */
export const minutesBetween = (start: string, end: string) =>
  Math.max(0, Math.round((+new Date(end) - +new Date(start)) / 60_000));

/** "2 h 05 min", "45 min". */
export const formatMinutes = (m: number) =>
  m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
