import type { JobNoteDto } from '@lse/shared';
import { useState } from 'react';
import { useMe } from '../../api/hooks';
import { useAddNote, useDeleteNote, useNotes } from '../../api/jobDetail';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, ButtonRow, List, Section, StaticRow, TextAreaField } from '../../components/ui';
import { formatDateTime } from '../syncFormat';

/** Notes from the job: access codes, what was found, what's left to do. Newest first. */
export function NotesSection({ jobId }: { jobId: string }) {
  const me = useMe();
  const notes = useNotes(jobId);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<JobNoteDto | null>(null);
  const canRecord = !!me.data && me.data.role !== 'accountant';
  const canDelete = (n: JobNoteDto) =>
    canRecord && (me.data?.role === 'owner' || n.userId === me.data?.user.id);
  const list = notes.data ?? [];
  if (!canRecord && list.length === 0) return null;

  return (
    <Section header="Notes" footer={list.length ? 'Everyone on the job sees these.' : undefined}>
      <List label="Job notes">
        {list.map((n) => {
          const body = (
            <span className="row__main">
              <span className="row__title note-body">{n.body}</span>
              <span className="row__sub">
                {n.userName} · {formatDateTime(n.createdAt)}
              </span>
            </span>
          );
          return (
            <li key={n.id}>
              {canDelete(n) ? (
                <button
                  type="button"
                  className="row"
                  onClick={() => setDeleting(n)}
                  aria-label={`Note: ${n.body}`}
                >
                  {body}
                </button>
              ) : (
                <StaticRow>{body}</StaticRow>
              )}
            </li>
          );
        })}
        {canRecord && (
          <li>
            <ButtonRow
              onClick={() => setAdding(true)}
              title={<span className="row-action">Add Note…</span>}
            />
          </li>
        )}
      </List>
      {adding && <AddNoteSheet jobId={jobId} onClose={() => setAdding(false)} />}
      {deleting && (
        <DeleteNoteSheet jobId={jobId} note={deleting} onClose={() => setDeleting(null)} />
      )}
    </Section>
  );
}

function AddNoteSheet({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [body, setBody] = useState('');
  const add = useAddNote(jobId);
  const toast = useToast();
  const save = () => {
    if (!body.trim() || add.isPending) return;
    add.mutate(body, { onSuccess: () => (toast.show('Note added'), onClose()) });
  };
  return (
    <Sheet
      open
      title="Add Note"
      onClose={onClose}
      action={
        <Button variant="plain" onClick={save} disabled={!body.trim()} loading={add.isPending}>
          Add
        </Button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Section>
          <List className="form-list">
            <TextAreaField
              label="Note"
              rows={5}
              maxLength={4000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              data-autofocus
            />
          </List>
        </Section>
        {add.error && (
          <p className="field-error" role="alert">
            {add.error.message}
          </p>
        )}
      </form>
    </Sheet>
  );
}

function DeleteNoteSheet({
  jobId,
  note,
  onClose,
}: {
  jobId: string;
  note: JobNoteDto;
  onClose: () => void;
}) {
  const remove = useDeleteNote(jobId);
  const toast = useToast();
  return (
    <Sheet open title="Note" onClose={onClose} cancelLabel="Done">
      <p className="sheet__text note-body">{note.body}</p>
      <p className="sheet-hint">
        {note.userName} · {formatDateTime(note.createdAt)}
      </p>
      {remove.error && (
        <p className="field-error" role="alert">
          {remove.error.message}
        </p>
      )}
      <div className="button-stack">
        <Button
          variant="plain"
          block
          className="destructive-text"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(note.id, { onSuccess: () => (toast.show('Note deleted'), onClose()) })
          }
        >
          Delete Note
        </Button>
      </div>
    </Sheet>
  );
}
