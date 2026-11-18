import { formatPence } from '@lse/shared';

/** £1,234.56 with a true minus sign for negatives. */
export const money = (p: number) => `${p < 0 ? '−' : ''}${formatPence(Math.abs(p))}`;
/** Whole pounds for headline figures and chart labels: £12,345. */
export const pounds = (p: number) =>
  `${p < 0 ? '−' : ''}£${Math.round(Math.abs(p) / 100).toLocaleString('en-GB')}`;
/** Compact: £12.3k */
export const compact = (p: number) => {
  const v = Math.abs(p) / 100;
  const s = v >= 1000 ? `£${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `£${Math.round(v)}`;
  return `${p < 0 ? '−' : ''}${s}`;
};
export const shortDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Change as a percentage of the earlier figure; null when there's nothing to compare against. */
export const changePct = (now: number, before: number) =>
  before === 0 ? null : Math.round(((now - before) * 100) / Math.abs(before));

/** Saves a file: the share sheet on phones that support files, else a download. */
export async function saveFile(text: string, name: string, type = 'text/csv') {
  const file = new File([text], name, { type });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] }) && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
    await nav.share({ files: [file], title: name }).catch(() => undefined);
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
