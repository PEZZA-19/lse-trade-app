import type { AppointmentListItemDto } from '@lse/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useCreateAppointment,
  useDeleteAppointment,
  useJobs,
  useMembers,
  useMoveAppointment,
  useSession,
} from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, List, Section, SelectField, TextField } from '../../components/ui';
import { addMinutes, formatDayShort, fromInputs, toDateInput, toTimeInput } from '../../lib/dates';
import { AppointmentJobPicker } from './AppointmentJobPicker';

export type AppointmentSheetState =
  | { mode: 'create'; jobId?: string; jobLabel?: string; start?: Date }
  | {
      mode: 'edit';
      appointment: Pick<
        AppointmentListItemDto,
        'id' | 'jobNumber' | 'jobTitle' | 'startsAt' | 'endsAt' | 'userId'
      >;
    };

/** Book (from a job or an empty slot), move, reassign or delete an appointment. */
export function AppointmentSheet(props: {
  state: AppointmentSheetState | null;
  onClose: () => void;
}) {
  return props.state ? <Inner state={props.state} onClose={props.onClose} /> : null;
}

function Inner({ state, onClose }: { state: AppointmentSheetState; onClose: () => void }) {
  const editing = state.mode === 'edit' ? state.appointment : null;
  const initialStart = editing
    ? new Date(editing.startsAt)
    : (state.mode === 'create' && state.start) || nextHour();
  const initialEnd = editing ? new Date(editing.endsAt) : addMinutes(initialStart, 120);
  const session = useSession();
  const [jobId, setJobId] = useState(state.mode === 'create' ? (state.jobId ?? '') : '');
  const [date, setDate] = useState(toDateInput(initialStart));
  const [start, setStart] = useState(toTimeInput(initialStart));
  const [end, setEnd] = useState(toTimeInput(initialEnd));
  const [userId, setUserId] = useState<string>(
    editing ? (editing.userId ?? '') : (session.data?.user.id ?? ''),
  );
  const members = useMembers();
  const jobs = useJobs('active');
  const create = useCreateAppointment();
  const move = useMoveAppointment();
  const remove = useDeleteAppointment();
  const toast = useToast();
  const needsJob = state.mode === 'create' && !state.jobId;

  const startsAt = fromInputs(date, start);
  const endsAt = fromInputs(date, end);
  const timeError =
    startsAt && endsAt && endsAt <= startsAt ? 'The end must be after the start' : undefined;
  const ready = !!startsAt && !!endsAt && !timeError && (!needsJob || !!jobId);
  const error = create.error ?? move.error ?? remove.error;
  const fields = error instanceof ApiError ? error.fields : {};
  const busy = create.isPending || move.isPending || remove.isPending;

  const save = () => {
    if (!ready || busy) return;
    const input = {
      startsAt: startsAt!.toISOString(),
      endsAt: endsAt!.toISOString(),
      userId: userId || null,
    };
    if (editing)
      move.mutate(
        { id: editing.id, ...input },
        {
          onSuccess: () => (
            toast.show(`Moved to ${formatDayShort(startsAt!)}, ${start}`),
            onClose()
          ),
        },
      );
    else
      create.mutate(
        { jobId, ...input },
        {
          onSuccess: (j) => {
            toast.show(
              `Job ${j.number} booked for ${formatDayShort(startsAt!)}, ${start}` +
                (j.stage.systemKey === 'scheduled' ? ' · Booked in' : ''),
            );
            onClose();
          },
        },
      );
  };

  const title = editing
    ? `Job ${editing.jobNumber}`
    : state.mode === 'create' && state.jobLabel
      ? `Book ${state.jobLabel}`
      : 'New appointment';

  return (
    <Sheet
      open
      title={title}
      onClose={onClose}
      action={
        <Button
          variant="plain"
          onClick={save}
          disabled={!ready}
          loading={busy && !remove.isPending}
        >
          {editing ? 'Save' : 'Book'}
        </Button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {editing && <p className="sheet__text">{editing.jobTitle}</p>}
        <Section>
          <List className="form-list">
            {needsJob && (
              <AppointmentJobPicker
                value={jobId}
                onChange={setJobId}
                jobs={jobs.data?.items ?? []}
                loading={jobs.isPending}
                loadError={jobs.isError}
                onRetry={() => void jobs.refetch()}
                error={fields.jobId}
              />
            )}
            <TextField
              label="Date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
            <TextField
              label="Starts"
              type="time"
              step={900}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
            <TextField
              label="Ends"
              type="time"
              step={900}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              error={timeError ?? fields.endsAt}
              required
            />
            <SelectField
              label="Who"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              error={fields.userId}
            >
              <option value="">Anyone</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </SelectField>
          </List>
        </Section>
        {error && !Object.keys(fields).length && (
          <p className="readiness" role="alert">
            {error.message}
          </p>
        )}
        {!editing && (
          <p className="section__footer">
            Booking a job that is Unassigned or Assigned moves it to Booked in.
          </p>
        )}
        {editing && (
          <Button
            variant="destructive"
            block
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(editing.id, {
                onSuccess: (j) => {
                  toast.show(`Appointment deleted · job ${j.number} is now ${j.stage.name}`);
                  onClose();
                },
              })
            }
          >
            Delete appointment
          </Button>
        )}
      </form>
    </Sheet>
  );
}

function nextHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}
