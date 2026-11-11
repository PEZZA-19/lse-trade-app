import type { JobPhotoDto } from '@lse/shared';
import { useRef, useState } from 'react';
import { useMe } from '../../api/hooks';
import { useAddPhoto, useDeletePhoto, usePhotos } from '../../api/jobDetail';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, ButtonRow, List, Section, TextField } from '../../components/ui';
import { resizePhoto } from '../../lib/photos';
import { formatDateTime } from '../syncFormat';

type Picked = { dataUrl: string; width: number; height: number };

/** Before/after and "what's behind the wall" photos. Resized on the phone before upload. */
export function PhotosSection({ jobId }: { jobId: string }) {
  const me = useMe();
  const photos = usePhotos(jobId);
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [viewing, setViewing] = useState<JobPhotoDto | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const canRecord = !!me.data && me.data.role !== 'accountant';
  const list = photos.data ?? [];
  if (!canRecord && list.length === 0) return null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setPickError(null);
    try {
      setPicked(await resizePhoto(file));
    } catch (e) {
      setPickError(e instanceof Error ? e.message : 'Couldn’t read that photo.');
    }
  };

  return (
    <Section
      header="Photos"
      footer={
        pickError ??
        (list.length
          ? 'Tap a photo to see it full size.'
          : 'Photos are resized on your phone before they upload.')
      }
    >
      {(list.length > 0 || canRecord) && (
        <List>
          {list.length > 0 && (
            <li className="photo-grid-row">
              <ul className="photo-grid" aria-label="Job photos">
                {list.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="photo-grid__item"
                      onClick={() => setViewing(p)}
                      aria-label={p.caption ?? `Photo by ${p.userName}`}
                    >
                      <img src={p.url} alt="" loading="lazy" decoding="async" />
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          )}
          {canRecord && (
            <li>
              <ButtonRow
                onClick={() => input.current?.click()}
                title={<span className="row-action">Add Photo…</span>}
              />
            </li>
          )}
        </List>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/*"
        hidden
        data-testid="photo-input"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {picked && <UploadSheet jobId={jobId} picked={picked} onClose={() => setPicked(null)} />}
      {viewing && (
        <PhotoViewer
          jobId={jobId}
          photo={viewing}
          canDelete={
            canRecord && (me.data?.role === 'owner' || viewing.userName === me.data?.user.name)
          }
          onClose={() => setViewing(null)}
        />
      )}
    </Section>
  );
}

function UploadSheet({
  jobId,
  picked,
  onClose,
}: {
  jobId: string;
  picked: Picked;
  onClose: () => void;
}) {
  const [caption, setCaption] = useState('');
  const add = useAddPhoto(jobId);
  const toast = useToast();
  const kb = Math.round((picked.dataUrl.length * 3) / 4 / 1024);
  const save = () =>
    add.mutate(
      { dataUrl: picked.dataUrl, width: picked.width, height: picked.height, caption },
      { onSuccess: () => (toast.show('Photo added'), onClose()) },
    );
  return (
    <Sheet
      open
      title="Add Photo"
      onClose={onClose}
      action={
        <Button variant="plain" onClick={save} loading={add.isPending}>
          Upload
        </Button>
      }
    >
      <div className="photo-preview">
        <img src={picked.dataUrl} alt="Photo to upload" />
      </div>
      <Section footer={`${picked.width} × ${picked.height}, about ${kb} KB.`}>
        <List className="form-list">
          <TextField
            label="Caption"
            placeholder="Optional"
            maxLength={300}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </List>
      </Section>
      {add.error && (
        <p className="field-error" role="alert">
          {add.error.message}
        </p>
      )}
    </Sheet>
  );
}

function PhotoViewer(props: {
  jobId: string;
  photo: JobPhotoDto;
  canDelete: boolean;
  onClose: () => void;
}) {
  const { photo: p, onClose } = props;
  const remove = useDeletePhoto(props.jobId);
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  return (
    <Sheet open large title={p.caption ?? 'Photo'} onClose={onClose} cancelLabel="Done">
      <div className="photo-preview photo-preview--large">
        <img src={p.url} alt={p.caption ?? 'Job photo'} />
      </div>
      <p className="sheet-hint">
        {p.userName} · {formatDateTime(p.createdAt)}
      </p>
      {remove.error && (
        <p className="field-error" role="alert">
          {remove.error.message}
        </p>
      )}
      {props.canDelete && (
        <div className="button-stack">
          {confirm ? (
            <Button
              variant="destructive"
              block
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(p.id, { onSuccess: () => (toast.show('Photo deleted'), onClose()) })
              }
            >
              Delete Photo for Everyone
            </Button>
          ) : (
            <Button
              variant="plain"
              block
              className="destructive-text"
              onClick={() => setConfirm(true)}
            >
              Delete Photo…
            </Button>
          )}
        </div>
      )}
    </Sheet>
  );
}
