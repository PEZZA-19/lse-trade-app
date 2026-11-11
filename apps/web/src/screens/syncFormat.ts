const fmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
export const formatDateTime = (iso: string) => fmt.format(new Date(iso));

const CREATED: Record<string, string> = {
  '/customers': 'New customer',
  '/quotes': 'New quote',
  '/jobs': 'New job',
};
/** What a queued one-off action was, in words. */
export function describeAction(path: string): string {
  if (path.endsWith('/timer/start')) return 'Timer started';
  if (path.endsWith('/timer/stop')) return 'Timer stopped';
  return CREATED[path] ?? 'Change';
}
