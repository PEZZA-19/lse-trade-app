import { z } from 'zod';
import type { JobProfitDto } from './reports';

const isoTime = z.iso.datetime({ offset: true });
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable();

/** Longest single hand-entered timesheet: a very long day, not a forgotten timer. */
export const TIMESHEET_MAX_MINUTES = 16 * 60;

const span = <T extends { startedAt?: string; endedAt?: string }>(v: T) =>
  !v.startedAt ||
  !v.endedAt ||
  (Date.parse(v.endedAt) > Date.parse(v.startedAt) &&
    Date.parse(v.endedAt) - Date.parse(v.startedAt) <= TIMESHEET_MAX_MINUTES * 60_000);
const spanError = {
  message: 'The end must be after the start, and no more than 16 hours later',
  path: ['endedAt'],
};

/** Time typed in by hand ("forgot the timer"). Owner may enter it for anyone; staff for themselves. */
export const timesheetCreate = z
  .object({
    userId: z.uuid().optional(),
    startedAt: isoTime,
    endedAt: isoTime,
    note: text(500).optional(),
  })
  .refine(span, spanError);
export type TimesheetCreate = z.input<typeof timesheetCreate>;

export const timesheetUpdate = z
  .object({
    startedAt: isoTime.optional(),
    endedAt: isoTime.optional(),
    note: text(500).optional(),
  })
  .refine(span, spanError);
export type TimesheetUpdate = z.input<typeof timesheetUpdate>;

/** A material (or other cost) added on the job by hand, e.g. bought at the counter. */
export const jobLineCreate = z.object({
  kind: z.enum(['material', 'labour', 'carriage']).default('material'),
  description: z.string().trim().min(1, 'Say what it is').max(500),
  qtyMilli: z.number().int().positive().max(100_000_000).default(1000),
  /** What it cost us per unit. */
  unitCostPence: z.number().int().min(0).max(100_000_000).nullable().default(null),
  /** What the customer pays per unit; empty = cost × the default markup. */
  unitSellPence: z.number().int().min(0).max(100_000_000).nullable().default(null),
  priceItemId: z.uuid().nullable().optional(),
});
export type JobLineCreate = z.input<typeof jobLineCreate>;
export const jobLineUpdate = z.object({
  description: z.string().trim().min(1).max(500).optional(),
  qtyMilli: z.number().int().positive().max(100_000_000).optional(),
  unitCostPence: z.number().int().min(0).max(100_000_000).nullable().optional(),
  unitSellPence: z.number().int().min(0).max(100_000_000).nullable().optional(),
});
export type JobLineUpdate = z.input<typeof jobLineUpdate>;

export const jobNoteCreate = z.object({
  body: z.string().trim().min(1, 'Write something').max(4000),
});

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PHOTO_MAX_BYTES = 3_000_000;
/** A photo resized on the device and sent as a data URL (one request, works through the outbox). */
export const photoUpload = z.object({
  dataUrl: z
    .string()
    .max(Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 100)
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Not a JPEG, PNG or WebP photo'),
  caption: text(300).optional(),
  width: z.number().int().positive().max(10000).optional(),
  height: z.number().int().positive().max(10000).optional(),
});
export type PhotoUpload = z.input<typeof photoUpload>;

/** Owner sets what a person costs per hour: base cost plus tax/on-costs. null clears it. */
export const memberCostUpdate = z
  .object({
    baseCostPence: z.number().int().min(0).max(100_000),
    onCostPence: z.number().int().min(0).max(100_000),
  })
  .nullable();
export type MemberCostUpdate = z.input<typeof memberCostUpdate>;

/** One person in Settings › Team, as the owner sees it. */
export interface TeamMemberDto {
  userId: string;
  name: string;
  role: string;
  /** What the customer is charged per hour (the business labour rate). */
  chargeOutPence: number;
  baseCostPence: number | null;
  onCostPence: number | null;
  /** base + on-cost; null when not set (the labour rate is used for profit). */
  costRatePence: number | null;
  isPlaceholder: boolean;
}

export interface JobNoteDto {
  id: string;
  userId: string;
  userName: string;
  body: string;
  createdAt: string;
}

export interface JobPhotoDto {
  id: string;
  /** Same-origin path that streams the image (signed-in only). */
  url: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
  userName: string;
  createdAt: string;
}

export interface LabourCostRow {
  userId: string;
  name: string;
  minutes: number;
  /** Cost per hour used; the labour rate when no cost rate is set for this person. */
  ratePence: number;
  rateIsDefault: boolean;
  costPence: number;
}

/** Quote against actual for one job. */
export interface JobCostingDto {
  profit: JobProfitDto;
  quoted: {
    labourMinutes: number;
    labourPence: number;
    materialsPence: number;
    otherPence: number;
  };
  labour: LabourCostRow[];
  /** Net sell value of materials added since the quote (bills and by hand). */
  extraMaterialsSellPence: number;
  /** True when every person with time here has their own cost rate. */
  allRatesSet: boolean;
}

/** Splits base64 data URL bytes without trusting the declared size. */
export function dataUrlBytes(dataUrl: string): { type: string; bytes: Uint8Array } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error('Not an image data URL');
  const bin = atob(m[2]!);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { type: m[1]!, bytes: out };
}
