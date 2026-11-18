import type { JobSummaryDto } from '@lse/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { IconCheck, IconChevronDown } from '../../components/icons';

/** In-flow listbox: native select popups can escape the sheet and ignore its theme. */
export function AppointmentJobPicker(props: {
  value: string;
  jobs: JobSummaryDto[];
  onChange: (id: string) => void;
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
  error?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ text: '', time: 0 });
  const id = useId();
  const current = props.jobs.find((j) => j.id === props.value);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const show = () => {
    setActive(
      Math.max(
        0,
        props.jobs.findIndex((j) => j.id === props.value),
      ),
    );
    setOpen(true);
  };
  const pick = (index: number) => {
    const job = props.jobs[index];
    if (!job) return;
    props.onChange(job.id);
    close();
  };
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  return (
    <li
      className="appointment-job-picker"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation(); // First Escape dismisses the picker, not the appointment draft.
          close();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={`row appointment-job-picker__button${props.error ? ' row--invalid' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-invalid={!!props.error || undefined}
        aria-describedby={props.error ? `${id}-error` : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
      >
        <span id={`${id}-label`} className="field__label">
          Job
        </span>
        <span id={`${id}-value`} className="appointment-job-picker__value">
          {current ? `${current.number} · ${current.title}` : 'Choose a job…'}
        </span>
        <IconChevronDown className="row__chevron" aria-hidden />
      </button>
      {open && (
        <div className="appointment-job-picker__choices">
          <ul
            ref={list}
            id={`${id}-list`}
            className="appointment-job-picker__list"
            role="listbox"
            aria-label="Job"
            aria-busy={props.loading}
            aria-activedescendant={props.jobs[active] ? `${id}-${active}` : undefined}
            tabIndex={0}
            onBlur={(e) => {
              if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setOpen(false);
            }}
            onKeyDown={(e) => {
              const last = Math.max(0, props.jobs.length - 1);
              const moves: Record<string, number> = {
                ArrowDown: Math.min(last, active + 1),
                ArrowUp: Math.max(0, active - 1),
                Home: 0,
                End: last,
              };
              if (e.key in moves) {
                e.preventDefault();
                setActive(moves[e.key]!);
              } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); // Never submit the appointment form from an option.
                pick(active);
              } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                const now = e.timeStamp;
                const text =
                  (now - typeahead.current.time < 700 ? typeahead.current.text : '') +
                  e.key.toLowerCase();
                typeahead.current = { text, time: now };
                const index = props.jobs.findIndex(
                  (j) =>
                    `${j.number} ${j.title}`.toLowerCase().startsWith(text) ||
                    j.title.toLowerCase().startsWith(text),
                );
                if (index >= 0) setActive(index);
              }
            }}
          >
            {props.jobs.map((job, index) => (
              <li
                key={job.id}
                id={`${id}-${index}`}
                role="option"
                aria-selected={job.id === props.value}
                className={`appointment-job-picker__option${index === active ? ' is-active' : ''}`}
                onPointerEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                <span>
                  {job.number} · {job.title}
                </span>
                {job.id === props.value && <IconCheck aria-hidden />}
              </li>
            ))}
          </ul>
          {props.loading && (
            <p className="section__footer" role="status">
              Loading jobs…
            </p>
          )}
          {props.loadError ? (
            <p className="section__footer" role="alert">
              Jobs could not be loaded.{' '}
              <button type="button" className="btn btn--plain" onClick={props.onRetry}>
                Try again
              </button>
            </p>
          ) : (
            !props.loading &&
            !props.jobs.length && (
              <p className="section__footer" role="status">
                No active jobs to book.
              </p>
            )
          )}
        </div>
      )}
      {props.error && (
        <div id={`${id}-error`} className="field-error" role="alert">
          {props.error}
        </div>
      )}
    </li>
  );
}
