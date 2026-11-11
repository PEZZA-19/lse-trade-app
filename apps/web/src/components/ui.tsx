import type { StageColour } from '@lse/shared';
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { IconChevronLeft, IconChevronRight, IconSearch } from './icons';

/* ---------------------------------- Page ---------------------------------- */

export function Page(props: {
  title: string;
  subtitle?: ReactNode;
  back?: { label: string; to?: string };
  actions?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="page">
      <div className="page__bar">
        {props.back && (
          <button
            type="button"
            className="page__back"
            onClick={() => (props.back?.to ? navigate(props.back.to) : navigate(-1))}
          >
            <IconChevronLeft width={20} height={20} />
            {props.back.label}
          </button>
        )}
        <div className="page__actions">{props.actions}</div>
      </div>
      <h1 className="page__title">{props.title}</h1>
      {props.subtitle && <p className="page__subtitle">{props.subtitle}</p>}
      {props.children}
    </div>
  );
}

/* --------------------------------- Buttons -------------------------------- */

type Variant = 'primary' | 'secondary' | 'plain' | 'destructive';
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    block?: boolean;
    large?: boolean;
    loading?: boolean;
  }
>(function Button(
  { variant = 'primary', block, large, loading, className, children, disabled, ...rest },
  ref,
) {
  const cls = ['btn', `btn--${variant}`, block && 'btn--block', large && 'btn--large', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type="button"
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
});

export function IconButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode },
) {
  const { label, children, ...rest } = props;
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ------------------------------ Lists & rows ------------------------------ */

export function Section(props: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="section">
      {props.header && (
        <h2 className="section__header">
          <span>{props.header}</span>
          {props.aside}
        </h2>
      )}
      {props.children}
      {props.footer && <p className="section__footer">{props.footer}</p>}
    </section>
  );
}

export function List(props: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ul className={['list', props.className].filter(Boolean).join(' ')} aria-label={props.label}>
      {props.children}
    </ul>
  );
}

interface RowContent {
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  lead?: ReactNode;
}
function RowInner({ title, sub, meta, lead, chevron }: RowContent & { chevron?: boolean }) {
  return (
    <>
      {lead}
      <span className="row__main">
        <span className="row__title">{title}</span>
        {sub && <span className="row__sub">{sub}</span>}
      </span>
      {meta && <span className="row__meta">{meta}</span>}
      {chevron && <IconChevronRight className="row__chevron" />}
    </>
  );
}

export function LinkRow(props: RowContent & { to: string }) {
  return (
    <Link className="row" to={props.to}>
      <RowInner {...props} chevron />
    </Link>
  );
}

export function ButtonRow(props: RowContent & { onClick: () => void; chevron?: boolean }) {
  return (
    <button type="button" className="row" onClick={props.onClick}>
      <RowInner {...props} />
    </button>
  );
}

export function StaticRow(props: { children: ReactNode; className?: string }) {
  return <div className={['row', props.className].filter(Boolean).join(' ')}>{props.children}</div>;
}

export function KeyValueRow(props: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <StaticRow className={props.strong ? 'total-row' : undefined}>
      <span className="kv" style={{ width: '100%' }}>
        <span className="kv__label">{props.label}</span>
        <span className="kv__value num">{props.value}</span>
      </span>
    </StaticRow>
  );
}

/* ------------------------------ Small controls ---------------------------- */

export function SearchField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search" role="search">
      <IconSearch />
      <input
        type="search"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        enterKeyHint="search"
      />
    </div>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Pill colours: the 10 stage colours (quotes use a subset). */
export type Tone = StageColour;
export function Pill(props: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill--${props.tone}`}>{props.children}</span>;
}

export function EmptyState(props: {
  icon: ReactNode;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {props.icon}
      <h2>{props.title}</h2>
      <p>{props.message}</p>
      {props.action}
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i}>
          <div className="skeleton" />
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------- Fields -------------------------------- */

interface FieldBase {
  label: string;
  error?: string | undefined;
}

export function TextField(props: FieldBase & InputHTMLAttributes<HTMLInputElement>) {
  const { label, error, ...rest } = props;
  const id = useId();
  return (
    <li>
      <div className={`row${error ? ' row--invalid' : ''}`}>
        <label className="field" htmlFor={id}>
          <span className="field__label">{label}</span>
          <input
            id={id}
            className="field__input"
            aria-invalid={!!error || undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            {...rest}
          />
        </label>
      </div>
      {error && (
        <div id={`${id}-err`} className="field-error" role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

export function TextAreaField(props: FieldBase & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { label, error, ...rest } = props;
  const id = useId();
  return (
    <li>
      <div className="row">
        <label className="field field--stacked" htmlFor={id}>
          <span className="visually-hidden">{label}</span>
          <textarea
            id={id}
            className="field__input"
            placeholder={label}
            aria-invalid={!!error || undefined}
            {...rest}
          />
        </label>
      </div>
      {error && <div className="field-error">{error}</div>}
    </li>
  );
}

export function SelectField(
  props: FieldBase & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode },
) {
  const { label, error, children, ...rest } = props;
  const id = useId();
  return (
    <li>
      <div className={`row${error ? ' row--invalid' : ''}`}>
        <label className="field" htmlFor={id}>
          <span className="field__label">{label}</span>
          <select id={id} className="field__input" {...rest}>
            {children}
          </select>
          <IconChevronRight className="row__chevron" />
        </label>
      </div>
      {error && <div className="field-error">{error}</div>}
    </li>
  );
}
