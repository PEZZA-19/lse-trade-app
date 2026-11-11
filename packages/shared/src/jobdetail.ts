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

/**
 * Tax and on-costs on top of the base cost: a fixed £ per hour, or a percentage of the base.
 * A percentage is turned into pence when it's saved (rounded half up to the penny), so every report
 * adds the same amount the owner saw on screen.
 */
export type OnCostMode = 'fixed' | 'percent';

/** base × bp / 10000, rounded half up to the penny (e.g. £20.00 + 22.5% → £4.50). */
export const onCostFromPercent = (baseCostPence: number, onCostBp: number) =>
  Math.floor((baseCostPence * onCostBp + 5000) / 10000);

/** Owner sets what a person costs per hour: base cost plus tax/on-costs. null clears it. */
export const memberCostUpdate = z
  .object({
    baseCostPence: z.number().int().min(0).max(100_000),
    onCostMode: z.enum(['fixed', 'percent']).default('fixed'),
    /** Fixed mode: £ per hour, in pence. */
    onCostPence: z.number().int().min(0).max(100_000).optional(),
    /** Percent mode: basis points of the base (2250 = 22.5%), up to 200%. */
    onCostBp: z.number().int().min(0).max(20_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.onCostMode === 'fixed' && v.onCostPence === undefined)
      ctx.addIssue({ code: 'custom', path: ['onCostPence'], message: 'Enter the £ per hour' });
    if (v.onCostMode === 'percent' && v.onCostBp === undefined)
      ctx.addIssue({ code: 'custom', path: ['onCostBp'], message: 'Enter the percentage' });
  })
  .nullable();
export type MemberCostUpdate = z.input<typeof memberCostUpdate>;

/** What is stored: the mode, the percentage (percent mode only) and the £/h it comes to. */
export function resolveOnCost(input: NonNullable<z.output<typeof memberCostUpdate>>): {
  mode: OnCostMode;
  bp: number | null;
  pence: number;
} {
  return input.onCostMode === 'percent'
    ? {
        mode: 'percent',
        bp: input.onCostBp!,
        pence: onCostFromPercent(input.baseCostPence, input.onCostBp!),
      }
    : { mode: 'fixed', bp: null, pence: input.onCostPence! };
}

/** Owner sets a person's own charge-out rate (£/h, in pence); null goes back to the business rate. */
export const chargeOutUpdate = z.object({
  chargeOutPence: z.number().int().min(0).max(100_000).nullable(),
});

/** A person's charge-out rate: their own if set, else the business labour rate. */
export const chargeOutFor = (own: number | null | undefined, labourRatePence: number) =>
  own ?? labourRatePence;

/** One person in Settings › Team, as the owner sees it. */
export interface TeamMemberDto {
  userId: string;
  name: string;
  role: string;
  /** What the customer is charged per hour of this person's time (their own rate, else the business labour rate). */
  chargeOutPence: number;
  /** True when no own rate is set (the business labour rate is used). */
  chargeOutIsDefault: boolean;
  baseCostPence: number | null;
  /** Always the £/h amount (in percent mode, what the percentage comes to). */
  onCostPence: number | null;
  onCostMode: OnCostMode | null;
  /** Percent mode only: 2250 = 22.5%. */
  onCostBp: number | null;
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
  /** This person's charge-out rate and what their minutes here are worth at it. */
  chargeOutRatePence: number;
  chargeOutPence: number;
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

/** "22.5", "22.5 %" → 2250 basis points (exact, at most 2 decimals, up to 200%); otherwise null. */
export function parsePercentBp(input: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(input);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 20_000 ? bp : null;
}
/** 2250 → "22.5", 2000 → "20". */
export const formatPercentBp = (bp: number) =>
  `${Math.floor(bp / 100)}${
    bp % 100
      ? `.${String(bp % 100)
          .padStart(2, '0')
          .replace(/0$/, '')}`
      : ''
  }`;
