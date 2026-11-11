import { z } from 'zod';

/** The 8 system stages (Tradify-style). The automation keys off these, never off names. */
export const SYSTEM_STAGE_KEYS = [
  'unassigned',
  'assigned',
  'scheduled',
  'in_progress',
  'to_invoice',
  'complete',
  'on_hold',
  'cancelled',
] as const;
export type SystemStageKey = (typeof SYSTEM_STAGE_KEYS)[number];

/** System stages a business may rename or delete. The rest are fixed. */
export const EDITABLE_SYSTEM_STAGES: readonly SystemStageKey[] = ['to_invoice', 'on_hold'];

export const STAGE_COLOURS = [
  'grey',
  'blue',
  'indigo',
  'purple',
  'teal',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
] as const;
export type StageColour = (typeof STAGE_COLOURS)[number];

export const STAGE_CAUSES = [
  'created',
  'created_from_quote',
  'manual',
  'assigned',
  'appointment_created',
  'appointment_deleted',
  'timer_started',
  'invoiced_and_paid',
] as const;
export type StageCause = (typeof STAGE_CAUSES)[number];

/** Plain-English reason for a history entry. */
export const STAGE_CAUSE_LABEL: Record<StageCause, string> = {
  created: 'Job created',
  created_from_quote: 'Created from quote',
  manual: 'Changed by hand',
  assigned: 'Someone was assigned',
  appointment_created: 'Appointment booked',
  appointment_deleted: 'Last appointment removed',
  timer_started: 'Timer started',
  invoiced_and_paid: 'Fully invoiced and paid',
};

export type StageEvent = Exclude<StageCause, 'created' | 'created_from_quote' | 'manual'>;

/**
 * Automatic transitions. Returns the system stage to move to, or null to stay put.
 * `current` is null when the job is in a custom stage.
 * - assigning: Unassigned → Assigned
 * - appointment created: Unassigned / Assigned → Booked in
 * - last appointment deleted: Booked in → Assigned (if anyone is assigned) or Unassigned
 * - timer started: → In Progress (from anything except Complete and Cancelled)
 * - fully invoiced and paid: → Complete (unless Cancelled)
 */
export function autoStage(
  event: StageEvent,
  current: SystemStageKey | null,
  ctx: { hasAssignees: boolean; appointmentsLeft: number } = {
    hasAssignees: false,
    appointmentsLeft: 0,
  },
): SystemStageKey | null {
  switch (event) {
    case 'assigned':
      return current === 'unassigned' ? 'assigned' : null;
    case 'appointment_created':
      return current === 'unassigned' || current === 'assigned' ? 'scheduled' : null;
    case 'appointment_deleted':
      return current === 'scheduled' && ctx.appointmentsLeft === 0
        ? ctx.hasAssignees
          ? 'assigned'
          : 'unassigned'
        : null;
    case 'timer_started':
      return current === 'in_progress' || current === 'complete' || current === 'cancelled'
        ? null
        : 'in_progress';
    case 'invoiced_and_paid':
      return current === 'complete' || current === 'cancelled' ? null : 'complete';
  }
}

/* ------------------------------- inputs ------------------------------- */

export const jobStageCreate = z.object({
  name: z.string().trim().min(1, 'Give the stage a name').max(40),
  colour: z.enum(STAGE_COLOURS),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type JobStageCreate = z.input<typeof jobStageCreate>;
export const jobStageUpdate = z
  .object({
    name: z.string().trim().min(1, 'Give the stage a name').max(40),
    colour: z.enum(STAGE_COLOURS),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
  })
  .partial();
export type JobStageUpdate = z.input<typeof jobStageUpdate>;

export const appointmentCreate = z
  .object({
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    userId: z.uuid().nullish(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'The end must be after the start',
    path: ['endsAt'],
  });
export type AppointmentCreate = z.input<typeof appointmentCreate>;

/* -------------------------------- DTOs -------------------------------- */

/** What a job carries about its stage (enough to draw the chip). */
export interface JobStageRef {
  id: string;
  systemKey: SystemStageKey | null;
  name: string;
  colour: StageColour;
  isActive: boolean;
}

export interface JobStageDto extends JobStageRef {
  sortOrder: number;
  isSystem: boolean;
  canRename: boolean;
  canDelete: boolean;
  jobCount: number;
}

export interface JobHistoryDto {
  id: string;
  fromName: string | null;
  toName: string;
  toColour: StageColour | null;
  cause: StageCause;
  userName: string | null;
  createdAt: string;
}

export interface AppointmentDto {
  id: string;
  startsAt: string;
  endsAt: string;
  userId: string | null;
}

export const canRenameStage = (key: SystemStageKey | null) =>
  key === null || EDITABLE_SYSTEM_STAGES.includes(key);
