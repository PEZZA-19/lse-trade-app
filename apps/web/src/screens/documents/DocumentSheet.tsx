import { useState } from 'react';
import { getPdf, sharePdf, useBusinessDocument, type DocSource } from '../../api/documents';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { IconShare } from '../../components/icons';
import { DocumentView } from './DocumentView';

/**
 * Preview of the quote or invoice exactly as the customer will get it, with a Share button that
 * opens the phone's share sheet (or saves the PDF on a computer). Sharing is Joe's own tap and
 * never marks anything as sent; when sharing isn't allowed yet, the reason is shown instead.
 */
export function DocumentSheet(props: {
  open: boolean;
  onClose: () => void;
  kind: DocSource;
  id: string;
  title: string;
  /** Null when sharing is allowed; otherwise why not (e.g. "Approve the invoice to share it"). */
  shareBlocked: string | null;
  /** Shown after a share, e.g. a reminder to tap Mark as Sent. */
  afterShare?: string;
}) {
  const { open, onClose, kind, id } = props;
  const doc = useBusinessDocument(kind, id, open);
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function share() {
    if (!doc.data) return;
    setBusy(true);
    try {
      const pdf = await getPdf(kind, id, doc.data);
      const outcome = await sharePdf(pdf, doc.data.fileName);
      if (outcome === 'downloaded') toast.show(`Saved ${doc.data.fileName}`);
      if (outcome !== 'cancelled' && props.afterShare) toast.show(props.afterShare);
    } catch {
      toast.show("Couldn't make the PDF. Nothing was shared.", { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={props.title}
      cancelLabel="Done"
      large
      action={
        props.shareBlocked ? null : (
          <button
            type="button"
            className="btn btn--plain btn--icon-label"
            onClick={() => void share()}
            disabled={!doc.data || busy}
          >
            <IconShare width={20} height={20} />
            {busy ? 'Preparing…' : 'Share'}
          </button>
        )
      }
    >
      {props.shareBlocked && (
        <p className="doc-note" role="note">
          {props.shareBlocked}
        </p>
      )}
      {doc.isPending && <p className="doc-note">Loading preview…</p>}
      {doc.isError && (
        <p className="doc-note doc-note--error" role="alert">
          Couldn't load the preview. {doc.error.message}{' '}
          <button type="button" className="btn btn--plain" onClick={() => void doc.refetch()}>
            Retry
          </button>
        </p>
      )}
      {doc.data && (
        <div className="paper-wrap">
          <DocumentView doc={doc.data} />
        </div>
      )}
    </Sheet>
  );
}
