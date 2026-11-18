import { useEffect, useRef, useState } from 'react';
import {
  AGE_BUCKETS,
  monthLabel,
  type MonthFlow,
  type PipelineStage,
  type StageColour,
} from '@lse/shared';
import { stageColour } from '../../components/Stage';
import { compact, money, pounds } from './format';

/** Age bucket colours: calm for current, warming to red as money gets older. */
export const AGE_COLOURS = [
  'var(--green)',
  'var(--yellow-bar)',
  'var(--orange)',
  'var(--red)',
  'var(--purple)',
];

/** One stacked bar of who owes what by age, with a legend that also reads the figures out. */
export function AgeBar({ buckets, label }: { buckets: number[]; label: string }) {
  const total = buckets.reduce((s, b) => s + Math.max(0, b), 0);
  return (
    <div className="agebar">
      <div
        className="agebar__track"
        role="img"
        aria-label={`${label}: ${AGE_BUCKETS.map((b, i) => `${b} ${money(buckets[i] ?? 0)}`).join(', ')}`}
      >
        {total > 0 ? (
          buckets.map((b, i) =>
            b > 0 ? (
              <span
                key={i}
                style={{ width: `${(b * 100) / total}%`, background: AGE_COLOURS[i] }}
              />
            ) : null,
          )
        ) : (
          <span style={{ width: '100%', background: 'var(--bg-fill)' }} />
        )}
      </div>
      <ul className="agebar__legend" aria-hidden="true">
        {AGE_BUCKETS.map((b, i) =>
          buckets[i] ? (
            <li key={b}>
              <i style={{ background: AGE_COLOURS[i] }} />
              <span>
                {b === 'Current'
                  ? 'Not due'
                  : b.replace(' days', 'd').replace('Over ', '90+').replace('90+90d', '90d+')}
              </span>
              <b>{compact(buckets[i]!)}</b>
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
}

/** Width of an element, kept up to date (charts are drawn at real pixel size so text stays crisp). */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(
      ([e]) => e && setW(Math.max(240, Math.round(e.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Money in and out by month (bars) with the bank balance at each month end (line, own scale). */
export function CashChart({ months }: { months: MonthFlow[] }) {
  const [ref, W] = useWidth<HTMLElement>(640);
  const H = 200;
  const pad = { l: 4, r: 4, t: 14, b: 26 };
  const plotH = H - pad.t - pad.b;
  const max = Math.max(1, ...months.flatMap((m) => [m.inPence, m.outPence]));
  const step = (W - pad.l - pad.r) / Math.max(1, months.length);
  const bw = Math.max(4, Math.min(20, step / 2 - 4));
  const y = (v: number) => pad.t + plotH * (1 - v / max);
  const bals = months.map((m) => m.closingPence);
  const lo = Math.min(0, ...bals);
  const hi = Math.max(1, ...bals);
  const by = (v: number) => pad.t + plotH * (1 - (v - lo) / (hi - lo || 1));
  const line = months
    .map(
      (m, i) =>
        `${i ? 'L' : 'M'}${(pad.l + step * i + step / 2).toFixed(1)},${by(m.closingPence).toFixed(1)}`,
    )
    .join(' ');
  const narrow = W < 420;
  return (
    <figure className="cashchart" ref={ref}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="cash-chart-title"
      >
        <title id="cash-chart-title">Money in and out by month, last 12 months</title>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="cashchart__axis" />
        {months.map((m, i) => {
          const x = pad.l + step * i + step / 2;
          return (
            <g key={m.month}>
              <rect
                x={x - bw - 1}
                y={y(m.inPence)}
                width={bw}
                height={Math.max(0, y(0) - y(m.inPence))}
                rx={3}
                className="cashchart__in"
              >
                <title>{`${monthLabel(m.month)}: in ${money(m.inPence)}`}</title>
              </rect>
              <rect
                x={x + 1}
                y={y(m.outPence)}
                width={bw}
                height={Math.max(0, y(0) - y(m.outPence))}
                rx={3}
                className="cashchart__out"
              >
                <title>{`${monthLabel(m.month)}: out ${money(m.outPence)}`}</title>
              </rect>
              {(!narrow || i % 2 === months.length % 2) && (
                <text x={x} y={H - 8} textAnchor="middle" className="cashchart__label">
                  {monthLabel(m.month).slice(0, 3)}
                </text>
              )}
            </g>
          );
        })}
        <path d={line} className="cashchart__balance" />
        {months.length > 0 && (
          <circle
            cx={pad.l + step * (months.length - 1) + step / 2}
            cy={by(bals[bals.length - 1]!)}
            r={4}
            className="cashchart__dot"
          />
        )}
      </svg>
      <figcaption className="cashchart__legend">
        <span>
          <i className="cashchart__key cashchart__key--in" />
          Money in
        </span>
        <span>
          <i className="cashchart__key cashchart__key--out" />
          Money out
        </span>
        <span>
          <i className="cashchart__key cashchart__key--bal" />
          Bank balance ({compact(bals[bals.length - 1] ?? 0)} now)
        </span>
      </figcaption>
      <table className="visually-hidden">
        <caption>Cash by month</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>In</th>
            <th>Out</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <td>{monthLabel(m.month)}</td>
              <td>{money(m.inPence)}</td>
              <td>{money(m.outPence)}</td>
              <td>{money(m.closingPence)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Jobs by stage: a bar per stage in the stage's own colour, with count and value. */
export function Pipeline({ stages, showValue }: { stages: PipelineStage[]; showValue: boolean }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <ul className="pipeline">
      {stages.map((s) => (
        <li key={s.key}>
          <span className="pipeline__name">
            <i className="stage-dot" style={{ color: stageColour(s.colour as StageColour) }} />
            {s.name}
          </span>
          <span className="pipeline__bar" aria-hidden="true">
            <span
              style={{
                width: `${(s.count * 100) / max}%`,
                background: stageColour(s.colour as StageColour),
              }}
            />
          </span>
          <span className="pipeline__count">{s.count}</span>
          {showValue && (
            <span className="pipeline__value">{s.valuePence ? pounds(s.valuePence) : '—'}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
