import type { AppointmentListItemDto } from '@lse/shared';
import { stageColour } from '../../components/Stage';
import { formatDayLong, formatTime, monthGrid, sameDay } from '../../lib/dates';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Month at a glance: up to 3 appointments per day (dots on phones), tap a day to open it. */
export function MonthGrid(props: {
  month: Date;
  appointments: AppointmentListItemDto[];
  onPickDay: (d: Date) => void;
}) {
  const days = monthGrid(props.month);
  const today = new Date();
  return (
    <div className="cal-month">
      <div className="cal-month__head" aria-hidden>
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="cal-month__grid">
        {days.map((d) => {
          const mine = props.appointments.filter((a) => sameDay(new Date(a.startsAt), d));
          const outside = d.getMonth() !== props.month.getMonth();
          return (
            <button
              key={+d}
              type="button"
              className={`cal-month__day${outside ? ' is-outside' : ''}${sameDay(d, today) ? ' is-today' : ''}`}
              onClick={() => props.onPickDay(d)}
              aria-label={`${formatDayLong(d)}: ${mine.length ? `${mine.length} appointment${mine.length === 1 ? '' : 's'}` : 'nothing booked'}`}
            >
              <span className="cal-month__num">{d.getDate()}</span>
              <span className="cal-month__events">
                {mine.slice(0, 3).map((a) => (
                  <span
                    key={a.id}
                    className="cal-month__event"
                    style={{ ['--ev' as string]: stageColour(a.stage.colour) }}
                  >
                    <span className="cal-month__dot" />
                    <span className="cal-month__label">
                      {formatTime(a.startsAt)} {a.jobNumber}
                    </span>
                  </span>
                ))}
                {mine.length > 3 && <span className="cal-month__more">+{mine.length - 3}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
