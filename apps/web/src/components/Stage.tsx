import type { JobStageRef, StageColour } from '@lse/shared';
import { useJobStages, useSetJobStage } from '../api/hooks';
import { NeedsAttentionError } from '../offline';
import { IconCheck } from './icons';
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
