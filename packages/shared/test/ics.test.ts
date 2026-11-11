import { describe, expect, it } from 'vitest';
import {
  buildIcs,
  calendarLinks,
  escapeIcsText,
  feedEvents,
  foldIcsLine,
  isAllDay,
} from '../src/ics';

const now = new Date('2026-11-11T18:00:00Z');
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

/** Minimal RFC 5545 structural check used by the API tests too. */
export function assertValidIcs(ics: string) {
  expect(ics.endsWith('\r\n')).toBe(true);
  const lines = ics.slice(0, -2).split('\r\n');
  for (const l of lines) {
    expect(new TextEncoder().encode(l).length, l).toBeLessThanOrEqual(75);
    expect(l).not.toMatch(/[\r\n]/);
  }
  const logical = unfold(ics).slice(0, -2).split('\r\n');
  expect(logical[0]).toBe('BEGIN:VCALENDAR');
  expect(logical.at(-1)).toBe('END:VCALENDAR');
  expect(logical).toContain('VERSION:2.0');
  expect(logical.some((l) => l.startsWith('PRODID:'))).toBe(true);
  const begins = logical.filter((l) => l === 'BEGIN:VEVENT').length;
  expect(logical.filter((l) => l === 'END:VEVENT').length).toBe(begins);
  const events = unfold(ics).split('BEGIN:VEVENT').slice(1);
  for (const e of events) {
    expect(e).toMatch(/\r\nUID:[^\r]+/);
    expect(e).toMatch(/\r\nDTSTAMP:\d{8}T\d{6}Z/);
    expect(e).toMatch(/\r\nDTSTART(;VALUE=DATE:\d{8}|:\d{8}T\d{6}Z)/);
    expect(e).toMatch(/\r\nDTEND(;VALUE=DATE:\d{8}|:\d{8}T\d{6}Z)/);
  }
  return events.length;
}

describe('iCalendar feed (RFC 5545)', () => {
  it('escapes text', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('folds long lines at 75 octets without breaking characters', () => {
    const long = 'DESCRIPTION:' + 'é'.repeat(80);
    const folded = foldIcsLine(long);
    for (const l of folded.split('\r\n'))
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(foldIcsLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('timed events in UTC, whole days as all-day dates (GMT and BST)', () => {
    const ics = buildIcs({
      name: 'LSE, jobs',
      now,
      events: [
        {
          uid: 'a1@lse-trade',
          start: new Date('2026-11-12T09:00:00Z'),
          end: new Date('2026-11-12T11:30:00Z'),
          summary: 'J-0001: Rewire; kitchen, hall',
          location: '1 Rue, Sark',
          description: 'Mrs Brown\nPhone: 01481 000000',
        },
        // 1–2 July local (BST): midnight London is 23:00 UTC the day before.
        {
          uid: 'a2@lse-trade',
          start: new Date('2026-06-30T23:00:00Z'),
          end: new Date('2026-07-02T23:00:00Z'),
          summary: 'All day',
        },
        // Winter whole day: midnight London = midnight UTC.
        {
          uid: 'a3@lse-trade',
          start: new Date('2026-12-01T00:00:00Z'),
          end: new Date('2026-12-02T00:00:00Z'),
          summary: 'Winter day',
        },
      ],
    });
    expect(assertValidIcs(ics)).toBe(3);
    const u = unfold(ics);
    expect(u).toContain('DTSTAMP:20261111T180000Z');
    expect(u).toContain('DTSTART:20261112T090000Z\r\nDTEND:20261112T113000Z');
    expect(u).toContain('DTSTART;VALUE=DATE:20260701\r\nDTEND;VALUE=DATE:20260703');
    expect(u).toContain('DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202');
    expect(u).toContain('SUMMARY:J-0001: Rewire\\; kitchen\\, hall');
    expect(u).toContain('LOCATION:1 Rue\\, Sark');
    expect(u).toContain('DESCRIPTION:Mrs Brown\\nPhone: 01481 000000');
    expect(u).toContain('X-WR-CALNAME:LSE\\, jobs');
    expect(u).toContain('X-WR-TIMEZONE:Europe/London');
  });

  it('all-day only for local midnight to midnight', () => {
    expect(isAllDay(new Date('2026-06-30T23:00:00Z'), new Date('2026-07-01T23:00:00Z'))).toBe(true);
    expect(isAllDay(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-02T00:00:00Z'))).toBe(
      false,
    );
    expect(isAllDay(new Date('2026-12-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'))).toBe(
      false,
    );
  });

  it('events carry stable ids and no money', () => {
    const [e] = feedEvents(
      [
        {
          id: 'appt-1',
          startsAt: '2026-11-12T09:00:00Z',
          endsAt: '2026-11-12T10:00:00Z',
          jobId: 'job-1',
          jobNumber: 'J-0007',
          jobTitle: 'Fuse board',
          customerName: 'Pat',
          customerPhone: null,
          siteAddress: null,
          assignee: 'Sam Spark',
        },
      ],
      'https://app.example',
    );
    expect(e).toMatchObject({
      uid: 'appt-1@lse-trade',
      summary: 'J-0007: Fuse board',
      description: 'Pat\nWith: Sam Spark',
      url: 'https://app.example/jobs/job-1',
    });
  });

  it('subscribe links', () => {
    const l = calendarLinks('https://app.example/api/public/calendar/abc.ics', 'LSE jobs');
    expect(l.webcal).toBe('webcal://app.example/api/public/calendar/abc.ics');
    expect(l.google).toBe(
      'https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fapp.example%2Fapi%2Fpublic%2Fcalendar%2Fabc.ics',
    );
    expect(l.outlook).toContain(
      'outlook.live.com/calendar/0/addfromweb?url=https%3A%2F%2Fapp.example',
    );
  });
});
