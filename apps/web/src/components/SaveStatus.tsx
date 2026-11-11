export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * Honest save indicator. "Saved" only appears after the server has confirmed the write.
 * Unsaved changes and failures stay visible until resolved.
 */
export function SaveStatus(props: {
  state: SaveState;
  onRetry?: () => void;
  errorMessage?: string | undefined;
}) {
  const { state } = props;
  if (state === 'idle') return null;
  const text =
    state === 'dirty'
      ? 'Unsaved changes'
      : state === 'saving'
        ? 'Saving…'
        : state === 'saved'
          ? 'Saved'
          : (props.errorMessage ?? 'Not saved');
  const tone = state === 'saved' ? 'saved' : state === 'error' ? 'error' : 'pending';
  return (
    <span className={`save-status save-status--${tone}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden />
      {text}
      {state === 'error' && props.onRetry && (
        <button
          type="button"
          className="btn btn--plain"
          onClick={props.onRetry}
          style={{ minHeight: 28, padding: '0 4px' }}
        >
          Retry
        </button>
      )}
    </span>
  );
}
