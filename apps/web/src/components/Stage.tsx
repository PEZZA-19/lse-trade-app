import type { JobStageRef, StageColour } from '@lse/shared';
import { useJobStages, useSetJobStage } from '../api/hooks';
import { NeedsAttentionError } from '../offline';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown } from './icons';
import { Sheet } from './Sheet';
import { useToast } from './Toast';
import { ButtonRow, List, Pill } from './ui';

/** Coloured chip for a job's stage. */
export function StagePill(props: { stage: Pick<JobStageRef, 'name' | 'colour'> }) {
  return <Pill tone={props.stage.colour}>{props.stage.name}</Pill>;
}

/** The stage's colour as a CSS value (grey and blue reuse the system label/accent colours). */
export const stageColour = (c: StageColour) =>
  c === 'grey' ? 'var(--label-3)' : c === 'blue' ? 'var(--accent)' : `var(--${c})`;

export function StageDot(props: { colour: StageColour | null }) {
  return (
    <span
      className="stage-dot"
      aria-hidden
      style={{
        marginRight: 12,
        color: props.colour ? stageColour(props.colour) : 'var(--separator)',
      }}
    />
  );
}

/** Manual stage change with the usual feedback (works offline through the outbox). */
export function useChangeStage() {
  const set = useSetJobStage();
  const toast = useToast();
  const change = (job: { id: string; number: string }, stage: JobStageRef) =>
    set.mutate(
      { id: job.id, stage },
      {
        onSuccess: (r) =>
          toast.show(
            r === 'queued'
              ? `Job ${job.number} moved to ${stage.name} on this device. It will sync when you’re back online.`
              : `Job ${job.number} moved to ${stage.name}`,
          ),
        onError: (e) =>
          toast.show(
            e instanceof NeedsAttentionError
              ? e.message
              : `Job ${job.number} not moved. ${e.message}`,
            {
              tone: 'error',
              action:
                e instanceof NeedsAttentionError
                  ? undefined
                  : { label: 'Retry', onAction: () => change(job, stage) },
            },
          ),
      },
    );
  return { change, pendingId: set.isPending ? set.variables?.id : undefined, set };
}

/** Bottom sheet listing every stage; the current one is ticked. */
export function StageSheet(props: {
  open: boolean;
  currentId: string | undefined;
  title?: string;
  onPick: (stage: JobStageRef) => void;
  onClose: () => void;
}) {
  const stages = useJobStages();
  return (
    <Sheet open={props.open} title={props.title ?? 'Move to stage'} onClose={props.onClose}>
      <List label="Stages">
        {(stages.data ?? []).map((s) => (
          <li key={s.id}>
            <ButtonRow
              onClick={() => {
                props.onClose();
                if (s.id !== props.currentId) props.onPick(s);
              }}
              lead={<StageDot colour={s.colour} />}
              title={s.name}
              sub={s.isActive ? undefined : 'Not on the active list'}
              meta={
                s.id === props.currentId ? (
                  <IconCheck width={20} height={20} aria-label="Current stage" />
                ) : undefined
              }
            />
          </li>
        ))}
      </List>
    </Sheet>
  );
}

/**
 * The job's stage as an accessible listbox (replaces the native select, whose options render
 * faint and right-aligned on Windows): a colour dot and a clear, left-aligned label per stage.
 * Keyboard: Enter/Space/↓ opens; ↑/↓, Home/End move; Enter/Space picks; Esc closes.
 */
export function StagePicker(props: {
  value: string;
  options: JobStageRef[];
  disabled?: boolean;
  onChange: (stage: JobStageRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = props.options.find((s) => s.id === props.value);
  const [pos, setPos] = useState<CSSProperties>({});
  const show = () => {
    setActive(
      Math.max(
        0,
        props.options.findIndex((s) => s.id === props.value),
      ),
    );
    // Fixed position next to the button, in a portal: cards clip their contents.
    const r = button.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = Math.min(420, props.options.length * 44 + 14);
    const side = { left: r.left + 8, width: r.width - 16 };
    setPos(
      below >= want || below >= above
        ? { ...side, top: r.bottom + 4, maxHeight: Math.min(want, below) }
        : { ...side, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(want, above) },
    );
    setOpen(true);
  };
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const pick = (s: JobStageRef) => {
    close();
    if (s.id !== props.value) props.onChange(s);
  };
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        close(false);
    };
    const gone = () => close(false);
    document.addEventListener('pointerdown', away);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('resize', gone);
    };
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);
  const onListKey = (e: React.KeyboardEvent) => {
    const last = props.options.length - 1;
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
      e.preventDefault();
      const s = props.options[active];
      if (s) pick(s);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  };
  return (
    <div className="stage-picker">
      <button
        ref={button}
        type="button"
        className="row stage-picker__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`Stage: ${current?.name ?? 'none'}`}
        disabled={props.disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="stage-picker__label">Stage</span>
        <span className="stage-picker__value">
          <StageDot colour={current?.colour ?? null} />
          {current?.name ?? 'Choose…'}
        </span>
        <IconChevronDown className="stage-picker__chevron" aria-hidden />
      </button>
      {open &&
        createPortal(
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label="Stage"
            tabIndex={-1}
            className="stage-picker__list"
            style={pos}
            aria-activedescendant={`${id}-${active}`}
            onKeyDown={onListKey}
          >
            {props.options.map((s, i) => (
              <li
                key={s.id}
                id={`${id}-${i}`}
                role="option"
                aria-selected={s.id === props.value}
                className={`stage-picker__option${i === active ? ' is-active' : ''}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(s)}
              >
                <StageDot colour={s.colour} />
                <span className="stage-picker__name">{s.name}</span>
                {s.id === props.value && <IconCheck className="stage-picker__check" aria-hidden />}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
