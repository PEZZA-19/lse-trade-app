import type { AppointmentListItemDto } from '@lse/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAppointments, useMoveAppointment } from '../../api/hooks';
import { IconChevronLeft, IconChevronRight, IconPlus } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Button, IconButton, Page, Segmented } from '../../components/ui';
import {
  addDays,
  addMonths,
  formatDayLong,
  formatDayShort,
  formatMonth,
  formatTime,
  formatWeekday,
  fromInputs,
  monthGrid,
  sameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toDateInput,
} from '../../lib/dates';
import { AppointmentSheet, type AppointmentSheetState } from '../sheets/AppointmentSheet';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';

type View = 'day' | 'week' | 'month';

/** Apple Calendar-style scheduler: day, week and month. */
export function ScheduleScreen() {
  const [params, setParams] = useSearchParams();
  const view = (
    ['day', 'week', 'month'].includes(params.get('view') ?? '') ? params.get('view') : 'day'
  ) as View;
  const date = fromInputs(params.get('date') ?? '', '00:00') ?? startOfDay(new Date());
  const go = (v: View, d: Date) => setParams({ view: v, date: toDateInput(d) }, { replace: true });
  const [sheet, setSheet] = useState<AppointmentSheetState | null>(null);
  const moveAppt = useMoveAppointment();
  const toast = useToast();

  const weekStart = startOfWeek(date);
  const range: [Date, Date] =
    view === 'day'
      ? [startOfDay(date), addDays(startOfDay(date), 1)]
      : view === 'week'
        ? [weekStart, addDays(weekStart, 7)]
        : [monthGrid(date)[0]!, addDays(monthGrid(date)[41]!, 1)];
  const appts = useAppointments(range[0], range[1]);
  const list = appts.data ?? [];

  const step = (n: number) =>
    go(
      view,
      view === 'day'
        ? addDays(date, n)
        : view === 'week'
          ? addDays(date, 7 * n)
          : addMonths(startOfMonth(date), n),
    );

  const onMove = (a: AppointmentListItemDto, s: Date, e: Date) =>
    moveAppt.mutate(
      { id: a.id, startsAt: s.toISOString(), endsAt: e.toISOString() },
      {
        onSuccess: () =>
          toast.show(`Job ${a.jobNumber} moved to ${formatDayShort(s)}, ${formatTime(s)}`),
        onError: (err) =>
          toast.show(`Not moved. ${err.message}`, {
            tone: 'error',
            action: { label: 'Retry', onAction: () => onMove(a, s, e) },
          }),
      },
    );
  const open = (a: AppointmentListItemDto) => setSheet({ mode: 'edit', appointment: a });
  const create = (start: Date) => setSheet({ mode: 'create', start });

  const title =
    view === 'month'
      ? formatMonth(date)
      : view === 'week'
        ? formatMonth(weekStart)
        : formatMonth(date);
  const sub =
    view === 'day'
      ? formatDayLong(date)
      : view === 'week'
        ? `${formatDayShort(weekStart)} – ${formatDayShort(addDays(weekStart, 6))}`
        : undefined;

  return (
    <Page
      title={title}
      subtitle={sub}
      wide
      actions={
        <>
          <Button variant="plain" onClick={() => go(view, startOfDay(new Date()))}>
            Today
          </Button>
          <IconButton label="New appointment" onClick={() => create(defaultStart(date))}>
            <IconPlus />
          </IconButton>
        </>
      }
    >
      <div className="cal-toolbar">
        <IconButton label={`Previous ${view}`} onClick={() => step(-1)}>
          <IconChevronLeft />
        </IconButton>
        <Segmented
          label="Calendar view"
          value={view}
          onChange={(v) => go(v, date)}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
        />
        <IconButton label={`Next ${view}`} onClick={() => step(1)}>
          <IconChevronRight />
        </IconButton>
      </div>

      {appts.isError && (
        <p className="readiness" role="alert">
          Couldn’t load the calendar. {appts.error.message}{' '}
          <Button variant="plain" onClick={() => appts.refetch()}>
            Try again
          </Button>
        </p>
      )}

      {view === 'day' && (
        <div className="cal-strip" role="group" aria-label="Choose a day">
          {Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map((d) => (
            <button
              key={+d}
              type="button"
              className={`cal-strip__day${sameDay(d, date) ? ' is-selected' : ''}${sameDay(d, new Date()) ? ' is-today' : ''}`}
              aria-pressed={sameDay(d, date)}
              onClick={() => go('day', d)}
            >
              <span>{formatWeekday(d).slice(0, 1)}</span>
              <strong>{d.getDate()}</strong>
            </button>
          ))}
        </div>
      )}

      {view === 'month' ? (
        <MonthGrid month={date} appointments={list} onPickDay={(d) => go('day', d)} />
      ) : (
        <TimeGrid
          key={view}
          days={
            view === 'day'
              ? [startOfDay(date)]
              : Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
          }
          appointments={list}
          onCreate={create}
          onOpen={open}
          onMove={onMove}
          showHeader={view === 'week'}
        />
      )}
      <p className="section__footer cal-hint">
        {view === 'month' ? (
          'Tap a day to open it.'
        ) : (
          <>
            Tap an empty time to book. Tap an appointment to change or delete it
            <span className="touch-only">; press and hold, then drag, to move it</span>
            <span className="pointer-only">, or drag it to move</span>.
          </>
        )}
      </p>
      <AppointmentSheet state={sheet} onClose={() => setSheet(null)} />
    </Page>
  );
}

function defaultStart(day: Date) {
  const now = new Date();
  const base = sameDay(day, now) ? now : addDays(startOfDay(day), 0);
  const d = new Date(base);
  if (sameDay(day, now)) d.setHours(now.getHours() + 1, 0, 0, 0);
  else d.setHours(9, 0, 0, 0);
  return d;
}
