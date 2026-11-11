/**
 * Calendar maths in the device's local time (Joe's devices are on Europe/Guernsey time).
 * Weeks start on Monday (UK).
 */
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const addMinutes = (d: Date, n: number) => new Date(+d + n * 60_000);
export const startOfWeek = (d: Date) => {
  const day = startOfDay(d);
  return addDays(day, -((day.getDay() + 6) % 7));
};
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const sameDay = (a: Date, b: Date) => startOfDay(a).getTime() === startOfDay(b).getTime();
/** Minutes since local midnight. */
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
export const snap = (minutes: number, step = 15) => Math.round(minutes / step) * step;

/** The 6×7 grid of days shown for a month (Monday first, padded with neighbouring months). */
export function monthGrid(month: Date): Date[] {
  const first = startOfWeek(startOfMonth(month));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

const pad = (n: number) => String(n).padStart(2, '0');
/** For <input type="date"> / <input type="time">. */
export const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function fromInputs(date: string, time: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) return null;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +t[1]!, +t[2]!);
}

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', o);
const time = fmt({ hour: '2-digit', minute: '2-digit' });
const dayLong = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const dayShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const month = fmt({ month: 'long', year: 'numeric' });
const weekday = fmt({ weekday: 'short' });
export const formatTime = (d: Date | string) => time.format(new Date(d));
export const formatDayLong = (d: Date) => dayLong.format(d);
export const formatDayShort = (d: Date) => dayShort.format(d);
export const formatMonth = (d: Date) => month.format(d);
export const formatWeekday = (d: Date) => weekday.format(d);
export const formatRange = (a: string, b: string) => `${formatTime(a)}–${formatTime(b)}`;

/** "1:05:09" for the running timer. */
export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${pad(m)}:${pad(s % 60)}`;
}
