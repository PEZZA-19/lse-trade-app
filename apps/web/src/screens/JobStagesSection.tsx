import { STAGE_COLOURS, type JobStageDto, type StageColour } from '@lse/shared';
import { useState } from 'react';
import { ApiError } from '../api/client';
import {
  useCreateStage,
  useDeleteStage,
  useJobStages,
  useSession,
  useUpdateStage,
} from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { StageDot, StagePill } from '../components/Stage';
import { useToast } from '../components/Toast';
import {
  Button,
  ButtonRow,
  List,
  ListSkeleton,
  Section,
  SelectField,
  StaticRow,
  TextField,
} from '../components/ui';

const COLOUR_LABEL: Record<StageColour, string> = {
  grey: 'Grey',
  blue: 'Blue',
  indigo: 'Indigo',
  purple: 'Purple',
  teal: 'Teal',
  green: 'Green',
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
  pink: 'Pink',
};

const describe = (s: JobStageDto) =>
  [
    s.isSystem ? 'System' : 'Custom',
    s.isActive ? 'On the active list' : 'Off the active list',
    `${s.jobCount} ${s.jobCount === 1 ? 'job' : 'jobs'}`,
  ].join(' · ');

/** Settings → Job stages: the 8 system stages plus the business's own. */
export function JobStagesSection() {
  const stages = useJobStages();
  const session = useSession();
  const isOwner = session.data?.role === 'owner';
  const [editing, setEditing] = useState<JobStageDto | 'new' | null>(null);

  return (
    <Section
      header="Job stages"
      footer={
        isOwner
          ? 'Jobs move through these automatically (assigned, booked in, timer started) or by hand. System stages can’t be renamed or deleted, apart from To Invoice and On Hold.'
          : 'Only the owner can change stages.'
      }
    >
      {stages.isPending ? (
        <ListSkeleton rows={3} />
      ) : stages.isError ? (
        <p role="alert">{stages.error.message}</p>
      ) : (
        <List label="Job stages">
          {stages.data.map((s) => (
            <li key={s.id}>
              {isOwner ? (
                <ButtonRow
                  onClick={() => setEditing(s)}
                  lead={<StageDot colour={s.colour} />}
                  title={s.name}
                  sub={describe(s)}
                  chevron
                />
              ) : (
                <StaticRow>
                  <StageDot colour={s.colour} />
                  <span className="row__main">
                    <span className="row__title">{s.name}</span>
                    <span className="row__sub">{describe(s)}</span>
                  </span>
                </StaticRow>
              )}
            </li>
          ))}
        </List>
      )}
      {isOwner && (
        <Button variant="plain" block onClick={() => setEditing('new')}>
          Add stage
        </Button>
      )}
      {editing && <StageEditSheet stage={editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

function StageEditSheet(props: { stage: JobStageDto | 'new'; onClose: () => void }) {
  const existing = props.stage === 'new' ? null : props.stage;
  const [name, setName] = useState(existing?.name ?? '');
  const [colour, setColour] = useState<StageColour>(existing?.colour ?? 'teal');
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(existing ? String(existing.sortOrder) : '');
  const create = useCreateStage();
  const update = useUpdateStage();
  const remove = useDeleteStage();
  const toast = useToast();
  const error = create.error ?? update.error ?? remove.error;
  const fields = error instanceof ApiError ? error.fields : {};
  const busy = create.isPending || update.isPending || remove.isPending;
  const order = sortOrder.trim() === '' ? undefined : Number(sortOrder);
  const orderOk = order === undefined || (Number.isInteger(order) && order >= 0);

  const save = () => {
    if (!name.trim() || !orderOk || busy) return;
    const done = { onSuccess: props.onClose };
    if (existing)
      update.mutate(
        {
          id: existing.id,
          ...(existing.canRename && name !== existing.name ? { name } : {}),
          colour,
          ...(existing.isSystem ? {} : { isActive }),
          ...(order !== undefined ? { sortOrder: order } : {}),
        },
        done,
      );
    else create.mutate({ name, colour, isActive, sortOrder: order }, done);
  };

  return (
    <Sheet
      open
      title={existing ? 'Edit stage' : 'New stage'}
      onClose={props.onClose}
      action={
        <Button variant="plain" onClick={save} disabled={!name.trim() || !orderOk} loading={busy}>
          {existing ? 'Save' : 'Add'}
        </Button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Section footer={<StagePill stage={{ name: name || 'Preview', colour }} />}>
          <List className="form-list">
            <TextField
              label="Name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              disabled={existing ? !existing.canRename : false}
              error={fields.name}
            />
            <SelectField
              label="Colour"
              value={colour}
              onChange={(e) => setColour(e.target.value as StageColour)}
            >
              {STAGE_COLOURS.map((c) => (
                <option key={c} value={c}>
                  {COLOUR_LABEL[c]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Active list"
              value={isActive ? 'yes' : 'no'}
              onChange={(e) => setIsActive(e.target.value === 'yes')}
              disabled={!!existing?.isSystem}
            >
              <option value="yes">Show these jobs</option>
              <option value="no">Hide these jobs</option>
            </SelectField>
            <TextField
              label="Order"
              inputMode="numeric"
              value={sortOrder}
              placeholder="After the others"
              onChange={(e) => setSortOrder(e.target.value)}
              error={!orderOk ? 'A whole number, 0 or more' : fields.sortOrder}
            />
          </List>
        </Section>
        {existing?.isSystem && !existing.canRename && (
          <p className="section__footer">
            “{existing.name}” is a system stage: jobs move into it automatically, so its name and
            active setting are fixed. You can change its colour and order.
          </p>
        )}
        {error && !Object.keys(fields).length && (
          <p className="readiness" role="alert">
            {error.message}
          </p>
        )}
        {existing?.canDelete && (
          <Button
            variant="destructive"
            block
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(existing.id, {
                onSuccess: () => {
                  toast.show(`Stage “${existing.name}” deleted`);
                  props.onClose();
                },
              })
            }
          >
            Delete stage
          </Button>
        )}
      </form>
    </Sheet>
  );
}
