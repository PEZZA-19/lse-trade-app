import type { AppointmentListItemDto } from '@lse/shared';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { stageColour } from '../../components/Stage';
import {
  addDays,
  addMinutes,
  formatRange,
  formatWeekday,
  minutesOfDay,
  sameDay,
  snap,
  startOfDay,
} from '../../lib/dates';
import { layoutDay } from './layout';

const HOUR_PX = 56;
const PX_PER_MIN = HOUR_PX / 60;
const LONG_PRESS_MS = 350;

type Appt = AppointmentListItemDto;
interface Drag {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  active: boolean;
  dMin: number;
  dDay: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Day or week time grid. Tap an empty slot to book; tap an appointment to open it; drag one to
 * move it (mouse: drag; touch: press and hold, then drag), snapping to 15 minutes.
 */
export function TimeGrid(props: {
  days: Date[];
  appointments: Appt[];
  onCreate: (start: Date) => void;
  onOpen: (a: Appt) => void;
  onMove: (a: Appt, startsAt: Date, endsAt: Date) => void;
  showHeader: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  // Pointer handlers read the latest drag synchronously, so keep a ref alongside the state.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const today = new Date();

  // Start scrolled to 7am, like Apple Calendar shows the working day.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX - 8;
  }, []);

  // While dragging on touch, stop the page from scrolling.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (dragRef.current?.active) e.preventDefault();
    };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);

  const colWidth = () => (cols.current ? cols.current.clientWidth / props.days.length : 1);

  const onSlot = (day: Date, e: PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // The half hour that was tapped.
    const minutes = Math.floor((e.clientY - rect.top) / PX_PER_MIN / 30) * 30;
    const start = addMinutes(startOfDay(day), Math.max(0, Math.min(23 * 60 + 30, minutes)));
    props.onCreate(start);
  };

  const down = (a: Appt, e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const d: Drag = {
      id: a.id,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      active: false,
      dMin: 0,
      dDay: 0,
    };
    if (e.pointerType !== 'mouse')
      d.timer = setTimeout(() => {
        if (dragRef.current?.id === a.id) setDrag({ ...dragRef.current, active: true });
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag(d);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.active) {
      if (e.pointerType === 'mouse' && Math.hypot(dx, dy) > 4) d.active = true;
      else if (e.pointerType !== 'mouse' && Math.hypot(dx, dy) > 8) {
        // Moved before the long press: it's a scroll, not a drag.
        clearTimeout(d.timer);
        setDrag(null);
        return;
      } else return;
    }
    setDrag({
      ...d,
      active: true,
      dMin: snap(dy / PX_PER_MIN),
      dDay: props.days.length > 1 ? Math.round(dx / colWidth()) : 0,
    });
  };
  const up = (a: Appt, e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    clearTimeout(d.timer);
    setDrag(null);
    if (!d.active) return props.onOpen(a);
    if (d.dMin === 0 && d.dDay === 0) return;
    const s = addMinutes(addDays(new Date(a.startsAt), d.dDay), d.dMin);
    const len = +new Date(a.endsAt) - +new Date(a.startsAt);
    props.onMove(a, s, new Date(+s + len));
  };
  const cancel = () => {
    if (dragRef.current) clearTimeout(dragRef.current.timer);
    setDrag(null);
  };

  return (
    <div className="cal-grid">
      {props.showHeader && (
        <div
          className="cal-grid__head"
          style={{ gridTemplateColumns: `repeat(${props.days.length}, 1fr)` }}
        >
          {props.days.map((d) => (
            <div key={+d} className={`cal-grid__day${sameDay(d, today) ? ' is-today' : ''}`}>
              <span>{formatWeekday(d)}</span>
              <strong>{d.getDate()}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="cal-grid__scroll" ref={scroller}>
        <div className="cal-grid__body" style={{ height: 24 * HOUR_PX }}>
          <div className="cal-grid__hours" aria-hidden>
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} style={{ top: h * HOUR_PX }}>
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </span>
            ))}
          </div>
          <div
            className="cal-grid__cols"
            ref={cols}
            style={{ gridTemplateColumns: `repeat(${props.days.length}, 1fr)` }}
          >
            {props.days.map((day) => {
              const mine = props.appointments.filter((a) => sameDay(new Date(a.startsAt), day));
              return (
                <div
                  key={+day}
                  className="cal-grid__col"
                  onClick={(e) => onSlot(day, e as unknown as PointerEvent<HTMLDivElement>)}
                  aria-label={`Book on ${day.toDateString()}`}
                >
                  {sameDay(day, today) && (
                    <div
                      className="cal-now"
                      style={{ top: minutesOfDay(today) * PX_PER_MIN }}
                      aria-hidden
                    />
                  )}
                  {layoutDay(mine).map(({ item: a, col, cols: n }) => {
                    const s = new Date(a.startsAt);
                    const e = new Date(a.endsAt);
                    const dragging = drag?.id === a.id && drag.active;
                    const top = (minutesOfDay(s) + (dragging ? drag.dMin : 0)) * PX_PER_MIN;
                    const sameDayEnd = sameDay(s, e) ? minutesOfDay(e) : 24 * 60;
                    const height = Math.max(22, (sameDayEnd - minutesOfDay(s)) * PX_PER_MIN - 2);
                    const preview = dragging ? addMinutes(addDays(s, drag.dDay), drag.dMin) : s;
                    const previewEnd = new Date(+preview + (+e - +s));
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={`cal-event${dragging ? ' is-dragging' : ''}`}
                        style={{
                          top,
                          height,
                          left: `${(col / n) * 100}%`,
                          width: `calc(${100 / n}% - 2px)`,
                          transform: dragging ? `translateX(${drag.dDay * 100 * n}%)` : undefined,
                          ['--ev' as string]: stageColour(a.stage.colour),
                        }}
                        onPointerDown={(ev) => down(a, ev)}
                        onPointerMove={move}
                        onPointerUp={(ev) => up(a, ev)}
                        onPointerCancel={cancel}
                        onClick={(ev) => ev.stopPropagation()}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault();
                            props.onOpen(a);
                          }
                        }}
                        aria-label={`Job ${a.jobNumber}, ${a.jobTitle}, ${formatRange(a.startsAt, a.endsAt)}${a.userName ? `, ${a.userName}` : ''}`}
                      >
                        <span className="cal-event__title">
                          {a.jobNumber} · {a.jobTitle}
                        </span>
                        {height > 36 && (
                          <span className="cal-event__sub">
                            {formatRange(preview.toISOString(), previewEnd.toISOString())}
                            {a.userName ? ` · ${a.userName}` : ''}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
