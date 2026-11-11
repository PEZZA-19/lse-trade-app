/**
 * iCalendar (RFC 5545) for the one-way calendar feed. Pure, so the API and the offline demo build the
 * same file. Timed events are written in UTC (…Z), which every calendar converts to local time;
 * whole-day bookings (local midnight to midnight in Europe/London) become all-day events.
 */
export interface IcsEvent {
  /** Stable across fetches (e.g. the appointment id) so calendars update rather than duplicate. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
}

export const ICS_ZONE = 'Europe/London';

/** TEXT escaping (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const enc = new TextEncoder();
/** Folds a content line at 75 octets (RFC 5545 3.1) without splitting a UTF-8 character. */
export function foldIcsLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 20261111T183000Z */
export const icsUtc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

const londonFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ICS_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function londonParts(d: Date) {
  const p = Object.fromEntries(londonFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}${p.second}` };
}

/** A booking that runs from local midnight to local midnight (one or more whole days). */
export function isAllDay(start: Date, end: Date): boolean {
  if (end <= start) return false;
  return londonParts(start).time === '000000' && londonParts(end).time === '000000';
}

export function buildIcs(opts: { name: string; events: IcsEvent[]; now: Date }): string {
  const stamp = icsUtc(opts.now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LSE Trade//Jobs feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(opts.name)}`,
    `X-WR-TIMEZONE:${ICS_ZONE}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of opts.events) {
    lines.push('BEGIN:VEVENT', `UID:${escapeIcsText(e.uid)}`, `DTSTAMP:${stamp}`);
    if (isAllDay(e.start, e.end)) {
      lines.push(
        `DTSTART;VALUE=DATE:${londonParts(e.start).date}`,
        `DTEND;VALUE=DATE:${londonParts(e.end).date}`,
        'TRANSP:TRANSPARENT',
      );
    } else {
      lines.push(`DTSTART:${icsUtc(e.start)}`, `DTEND:${icsUtc(e.end)}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url.replace(/[\r\n]/g, '')}`);
    lines.push('STATUS:CONFIRMED', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/** What a feed event may say: job number, title, customer, site and phone; never prices or money. */
export interface FeedAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  customerName: string;
  customerPhone: string | null;
  siteAddress: string | null;
  assignee: string | null;
}

export function feedEvents(rows: FeedAppointment[], appOrigin: string | null): IcsEvent[] {
  return rows.map((r) => ({
    uid: `${r.id}@lse-trade`,
    start: new Date(r.startsAt),
    end: new Date(r.endsAt),
    summary: `${r.jobNumber}: ${r.jobTitle}`,
    location: r.siteAddress,
    description: [
      r.customerName,
      r.customerPhone ? `Phone: ${r.customerPhone}` : null,
      r.assignee ? `With: ${r.assignee}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    url: appOrigin ? `${appOrigin}/jobs/${r.jobId}` : null,
  }));
}

/** Subscribe links: webcal for Apple/Outlook desktop, Google's add-by-URL, Outlook on the web. */
export function calendarLinks(httpsUrl: string, name: string) {
  const webcal = httpsUrl.replace(/^https?:\/\//, 'webcal://');
  return {
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(httpsUrl)}&name=${encodeURIComponent(name)}`,
  };
}

/** Settings › Calendar: the person's own links (only they can see them). */
export interface CalendarFeedDto {
  scope: 'mine' | 'all';
  /** Path of the feed, e.g. /api/public/calendar/<token>.ics; null = not made yet. */
  path: string | null;
  createdAt: string | null;
}
