import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Formatted } from '../lib/format.js';

/* Small shared pieces: readouts, dialogs, banners. */

export function Readout(p: {
  label: string;
  value: Formatted;
  hero?: boolean | undefined;
  stale?: boolean | undefined;
  sub?: string | undefined;
}) {
  return (
    <div
      className={`readout num ${p.hero ? 'hero' : ''} ${p.stale ? 'stale' : ''}`}
      role="group"
      aria-label={`${p.label}: ${p.value.label}${p.stale ? ', stale' : ''}`}
    >
      <span className="label" aria-hidden="true">
        {p.label}
      </span>
      <span className="value" aria-hidden="true">
        {p.value.value}
        {p.value.unit ? <span className="unit">{p.value.unit}</span> : null}
      </span>
      {p.sub ? (
        <span className="sub" aria-hidden="true">
          {p.sub}
        </span>
      ) : null}
    </div>
  );
}

export function Dialog(p: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  danger?: boolean | undefined;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [p]);
  return (
    <div className="dialog-backdrop" onClick={p.onClose}>
      <div
        ref={ref}
        className={`dialog ${p.danger ? 'danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title">{p.title}</h2>
        <div className="dialog-body">{p.children}</div>
        {p.actions ? <div className="btn-row dialog-actions">{p.actions}</div> : null}
      </div>
    </div>
  );
}

/** Confirm with a typed phrase or a plain second tap. */
export function ConfirmDialog(p: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  danger?: boolean | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog
      title={p.title}
      onClose={p.onClose}
      danger={p.danger}
      actions={
        <>
          <button type="button" className="btn" onClick={p.onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${p.danger ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await p.onConfirm();
                p.onClose();
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {p.confirmLabel}
          </button>
        </>
      }
    >
      {p.body}
      {err ? <p className="error">{err}</p> : null}
    </Dialog>
  );
}

export function Spinner(p: { label?: string }) {
  return <p className="muted">{p.label ?? 'Loading…'}</p>;
}

export function ErrorLine(p: { error: string | null }) {
  return p.error ? (
    <p className="error" role="alert">
      {p.error}
    </p>
  ) : null;
}
