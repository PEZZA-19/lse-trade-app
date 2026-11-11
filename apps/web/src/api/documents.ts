import type { BusinessDocument } from '@lse/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type DocSource = 'quotes' | 'invoices' | 'credit-notes';

export const documentKey = (kind: DocSource, id: string) => ['document', kind, id] as const;

/** The layout model behind the preview and the PDF. Refetched each time the preview opens. */
export const useBusinessDocument = (kind: DocSource, id: string, enabled: boolean) =>
  useQuery({
    queryKey: documentKey(kind, id),
    queryFn: () => api<BusinessDocument>('GET', `/${kind}/${id}/document`),
    enabled: enabled && !!id,
    staleTime: 0,
    gcTime: 0,
  });

/**
 * The PDF to share. From the server when online (the same renderer runs in the Worker); built on
 * the device from the same layout model in the offline preview build or when there's no signal.
 */
export async function getPdf(kind: DocSource, id: string, doc: BusinessDocument): Promise<Blob> {
  if (import.meta.env.VITE_DEMO !== '1') {
    try {
      const res = await fetch(`/api/${kind}/${id}/pdf`, { credentials: 'same-origin' });
      if (res.ok) return await res.blob();
    } catch {
      /* no signal: render locally below */
    }
  }
  const { renderPdf } = await import('@lse/shared/pdf');
  const bytes = await renderPdf(doc);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Opens the system share sheet with the PDF (Mail, Messages, Files, AirDrop...). Where the browser
 * can't share files (most desktops), the PDF is saved instead. Sharing never changes the
 * document's status: marking a quote or invoice as sent stays a separate tap.
 */
export async function sharePdf(blob: Blob, fileName: string): Promise<ShareOutcome> {
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: fileName.replace(/\.pdf$/, '') });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
