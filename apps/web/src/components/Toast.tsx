import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action?: { label: string; onAction: () => void };
}
interface ToastApi {
  show: (message: string, opts?: { tone?: Toast['tone']; action?: Toast['action'] }) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(Ctx);

/** Short confirmations ("Job 124 created") and errors with a Retry. Announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback<ToastApi['show']>((message, opts = {}) => {
    const id = next.current++;
    const toast: Toast = {
      id,
      message,
      tone: opts.tone ?? 'info',
      ...(opts.action ? { action: opts.action } : {}),
    };
    setToasts((t) => [...t.slice(-2), toast]);
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      toast.tone === 'error' ? 7000 : 3200,
    );
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.tone === 'error' ? ' toast--error' : ''}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                  t.action?.onAction();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
