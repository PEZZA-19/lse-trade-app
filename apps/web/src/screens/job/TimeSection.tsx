import { formatMinutes, type JobDetailDto, type TimesheetDto } from '@lse/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useMe, useMembers } from '../../api/hooks';
import { useAddTimesheet, useDeleteTimesheet, useUpdateTimesheet } from '../../api/jobDetail';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  ButtonRow,
  KeyValueRow,
  List,
  Section,
  SelectField,
  StaticRow,
  TextField,
} from '../../components/ui';
import { formatDayShort, formatRange, fromInputs, toDateInput, toTimeInput } from '../../lib/dates';

type Editing = { mode: 'add' } | { mode: 'edit'; sheet: TimesheetDto };

/**
 * Time on the job: timer entries plus time typed in by hand ("forgot the timer"). Anyone can fix
 * their own time; the owner can fix anyone's. Time already on an invoice is locked.
 */
export function TimeSection({ job: j }: { job: JobDetailDto }) {
  const me = useMe();
  const [editing, setEditing] = useState<Editing | null>(null);
  const role = me.data?.role;
  const myId = me.data?.user.id;
  const canRecord = !!role && role !== 'accountant';
  const canEdit = (t: TimesheetDto) =>
    canRecord && !t.invoiced && (role === 'owner' || t.userId === myId);

  if (!canRecord && j.timesheets.length === 0) return null;
  return (
    <Section
      header="Time"
      footer={
        j.timesheets.length
          ? `${formatMinutes(j.totalMinutes)} in total. Tap an entry to fix it; time on an invoice is locked.`
          : 'Use the timer above, or log time by hand if you forgot.'
      }
    >
      <List label="Timesheet entries">
        {j.timesheets.map((t) => {
          const title = `${formatDayShort(new Date(t.startedAt))} · ${formatRange(t.startedAt, t.endedAt)}`;
          const sub = [
            t.userName,
            t.source === 'manual' ? 'by hand' : null,
            t.invoiced ? 'invoiced' : null,
            t.note,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={t.id}>
              {canEdit(t) ? (
                <ButtonRow
                  onClick={() => setEditing({ mode: 'edit', sheet: t })}
                  title={title}
                  sub={sub}
                  meta={<span className="num">{formatMinutes(t.minutes)}</span>}
                  chevron
                />
              ) : (
                <StaticRow>
                  <span className="row__main">
                    <span className="row__title">{title}</span>
                    <span className="row__sub">{sub}</span>
                  </span>
                  <span className="row__meta num">{formatMinutes(t.minutes)}</span>
                </StaticRow>
              )}
            </li>
          );
        })}
        {canRecord && (
          <li>
            <ButtonRow
              onClick={() => setEditing({ mode: 'add' })}
              title={<span className="row-action">Log Time…</span>}
            />
          </li>
        )}
      </List>
      {editing && (
        <TimesheetSheet
          job={j}
          editing={editing}
          owner={role === 'owner'}
          myId={myId ?? ''}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  );
}

function TimesheetSheet(props: {
  job: JobDetailDto;
  editing: Editing;
  owner: boolean;
  myId: string;
  onClose: () => void;
}) {
  const { job, editing, owner, onClose } = props;
  const existing = editing.mode === 'edit' ? editing.sheet : null;
  const [openedAt] = useState(() => Date.now());
  const now = new Date(openedAt);
  const defStart = existing
    ? new Date(existing.startedAt)
    : roundDown(new Date(+now - 60 * 60_000));
  const defEnd = existing ? new Date(existing.endedAt) : roundDown(now);
  const [userId, setUserId] = useState(existing?.userId ?? props.myId);
  const [date, setDate] = useState(toDateInput(defStart));
  const [start, setStart] = useState(toTimeInput(defStart));
  const [end, setEnd] = useState(toTimeInput(defEnd));
  const [note, setNote] = useState(existing?.note ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const members = useMembers();
  const add = useAddTimesheet();
  const update = useUpdateTimesheet();
  const remove = useDeleteTimesheet();
  const toast = useToast();

  const s = fromInputs(date, start);
  let e = fromInputs(date, end);
  // An end before the start means it ran past midnight.
  if (s && e && e <= s) e = new Date(+e + 24 * 60 * 60_000);
  const minutes = s && e ? Math.round((+e - +s) / 60_000) : 0;
  const tooLong = minutes > 16 * 60;
  const future = !!e && +e > openedAt + 5 * 60_000;
  const localError = tooLong
    ? 'That is more than 16 hours. Split it into separate entries.'
    : future
      ? 'Time can only be logged once it has happened.'
      : undefined;
  const ready = !!s && !!e && minutes > 0 && !localError;
  const error = add.error ?? update.error ?? remove.error;
  const fields = error instanceof ApiError ? error.fields : {};
  const busy = add.isPending || update.isPending || remove.isPending;

  const save = () => {
    if (!ready || busy) return;
    const input = { startedAt: s!.toISOString(), endedAt: e!.toISOString(), note };
    if (existing)
      update.mutate(
        { id: existing.id, ...input },
        { onSuccess: () => (toast.show('Time updated'), onClose()) },
      );
    else
      add.mutate(
        { jobId: job.id, ...(owner ? { userId } : {}), ...input },
        {
          onSuccess: () => (
            toast.show(`${formatMinutes(minutes)} logged on job ${job.number}`),
            onClose()
          ),
        },
      );
  };

  if (confirmDelete && existing)
    return (
      <Sheet
        open
        title="Delete Time"
        onClose={onClose}
        onCancel={() => setConfirmDelete(false)}
        cancelLabel="Back"
      >
        <p className="sheet__text">
          Delete {formatMinutes(existing.minutes)} for {existing.userName} on{' '}
          {formatDayShort(new Date(existing.startedAt))}? This is recorded in the job’s audit log.
        </p>
        {error && (
          <p className="field-error" role="alert">
            {error.message}
          </p>
        )}
        <Button
          block
          large
          variant="destructive"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(existing.id, {
              onSuccess: () => (toast.show('Time deleted'), onClose()),
            })
          }
        >
          Delete Time
        </Button>
      </Sheet>
    );

  return (
    <Sheet
      open
      title={existing ? 'Edit Time' : 'Log Time'}
      onClose={onClose}
      action={
        <Button variant="plain" onClick={save} disabled={!ready} loading={busy}>
          Save
        </Button>
      }
    >
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          save();
        }}
      >
        <Section
          footer={
            existing
              ? `Logged by ${existing.source === 'timer' ? 'the timer' : 'hand'}.`
              : undefined
          }
        >
          <List className="form-list">
            {owner && !existing ? (
              <SelectField
                label="Person"
                value={userId}
                onChange={(ev) => setUserId(ev.target.value)}
                error={fields.userId}
              >
                {(members.data ?? []).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </SelectField>
            ) : existing ? (
              <li>
                <KeyValueRow label="Person" value={existing.userName} />
              </li>
            ) : null}
            <TextField
              label="Date"
              type="date"
              value={date}
              onChange={(ev) => setDate(ev.target.value)}
              required
            />
            <TextField
              label="Start"
              type="time"
              value={start}
              onChange={(ev) => setStart(ev.target.value)}
              error={fields.startedAt}
              required
            />
            <TextField
              label="End"
              type="time"
              value={end}
              onChange={(ev) => setEnd(ev.target.value)}
              error={localError ?? fields.endedAt}
              required
            />
            <li>
              <KeyValueRow
                label="Duration"
                value={minutes > 0 ? formatMinutes(minutes) : '—'}
                strong
              />
            </li>
            <TextField
              label="Note"
              placeholder="Optional"
              value={note}
              maxLength={500}
              onChange={(ev) => setNote(ev.target.value)}
            />
          </List>
        </Section>
        {error && (
          <p className="field-error" role="alert">
            {error.message}
          </p>
        )}
        {existing && (
          <div className="button-stack">
            <Button
              variant="plain"
              block
              className="destructive-text"
              onClick={() => setConfirmDelete(true)}
            >
              Delete Time
            </Button>
          </div>
        )}
      </form>
    </Sheet>
  );
}

function roundDown(d: Date) {
  const r = new Date(d);
  r.setMinutes(Math.floor(r.getMinutes() / 15) * 15, 0, 0);
  return r;
}
