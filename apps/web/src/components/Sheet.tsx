import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Modal sheet for create/edit (bottom sheet on phones, centred card on wider screens).
 * Cancel on the left, the one primary action on the right, like iOS.
 * Escape and the scrim close it; focus moves in on open and returns on close.
 */
export function Sheet(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  action?: ReactNode;
  cancelLabel?: string;
  /** Tall sheet for documents and previews. */
  large?: boolean;
  children: ReactNode;
}) {
  const { open, onClose } = props;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && panel.current) {
        const focusables = panel.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      const target = panel.current?.querySelector<HTMLElement>(
        '[data-autofocus], .sheet__body input, .sheet__body textarea',
      );
      (target ?? panel.current)?.focus();
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="sheet">
      <div className="sheet__scrim" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        className={props.large ? 'sheet__panel sheet__panel--large' : 'sheet__panel'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sheet__grabber" aria-hidden />
        <div className="sheet__bar">
          <button
            type="button"
            className="btn btn--plain"
            onClick={onClose}
            style={{ justifySelf: 'start' }}
          >
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <h2 id={titleId} className="sheet__title">
            {props.title}
          </h2>
          <div>{props.action}</div>
        </div>
        <div className="sheet__body">{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}
