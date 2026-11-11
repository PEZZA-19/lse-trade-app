import { useRef, useState, type PointerEvent, type ReactNode } from 'react';

export interface SwipeAction {
  label: string;
  icon: ReactNode;
  tone: 'blue' | 'green' | 'orange' | 'grey' | 'purple' | 'yellow';
  onAction: () => void;
}

const ACTION_W = 80;

/**
 * List row with trailing swipe actions (like Mail/Reminders). Drag left to reveal.
 * The actions stay in the DOM and in the tab order, so keyboard and screen-reader users
 * can reach them without swiping. A tap on the row while open just closes it.
 */
export function SwipeRow(props: { actions: SwipeAction[]; children: ReactNode }) {
  const max = props.actions.length * ACTION_W;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number; locked: 'x' | 'y' | null } | null>(
    null,
  );
  const moved = useRef(false);

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, base: offset, locked: null };
    moved.current = false;
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.locked === 'x') {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
      }
    }
    if (s.locked !== 'x') return;
    moved.current = true;
    const next = Math.min(0, Math.max(-max - 24, s.base + dx));
    setOffset(next);
  };
  const end = () => {
    if (start.current?.locked === 'x') setOffset((o) => (o < -max / 2 ? -max : 0));
    start.current = null;
    setDragging(false);
  };

  return (
    <div className="swipe">
      <div className="swipe__actions" aria-hidden={offset === 0 ? undefined : false}>
        {props.actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className={`swipe__action swipe__action--${a.tone}`}
            onClick={() => {
              setOffset(0);
              a.onAction();
            }}
            tabIndex={offset === 0 ? -1 : 0}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
      <div
        className={`swipe__content${dragging ? ' is-dragging' : ''}`}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onClickCapture={(e) => {
          if (moved.current || offset !== 0) {
            e.preventDefault();
            e.stopPropagation();
            if (!moved.current) setOffset(0);
          }
          moved.current = false;
        }}
      >
        {props.children}
      </div>
    </div>
  );
}
