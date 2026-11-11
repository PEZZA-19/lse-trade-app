import { formatPence } from '@lse/shared';

/** "£16.61 → £18.29": old struck through, new red if up, green if down. */
export function Change({ from, to, label }: { from: number; to: number; label?: string }) {
  const dir = to > from ? 'up' : to < from ? 'down' : null;
  return (
    <span
      className="change"
      aria-label={`${label ?? ''} was ${formatPence(from)}, now ${formatPence(to)}`}
    >
      <span className="change__old">{formatPence(from)}</span> →{' '}
      <span className={dir ? `change__${dir}` : undefined}>{formatPence(to)}</span>
    </span>
  );
}
