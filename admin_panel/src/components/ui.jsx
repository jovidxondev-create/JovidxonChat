import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { errorText, fieldText } from '../api.js';
import { useI18n } from '../i18n.js';

export function Spinner() {
  return (
    <div className="center">
      <div className="spinner" />
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="row between" style={{ marginBottom: 12 }}>
          {title && <h2 style={{ margin: 0 }}>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Badge({ tone = 'primary', children }) {
  return <span className={`badge ${tone === 'primary' ? '' : tone}`}>{children}</span>;
}

export function StatusBadge({ status }) {
  const { t } = useI18n();
  const tone = { active: 'success', suspended: 'danger', deleted: 'neutral' }[status] ?? 'neutral';
  return <Badge tone={tone}>{t(`status_${status}`)}</Badge>;
}

export function ErrorAlert({ error }) {
  const { t } = useI18n();
  if (!error) return null;
  return <div className="alert">{errorText(t, error)}</div>;
}

export function useFieldError(error) {
  const { t } = useI18n();
  return (field) => fieldText(t, error, field);
}

export function Modal({ title, children, onClose, wide, actions }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Portal ба body: backdrop-filter-и корт барои position: fixed контейнер мешуд (модал бурида мешуд).
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        {title && <h2>{title}</h2>}
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Pagination({ page, perPage, total, onPage }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil((total ?? 0) / perPage));
  return (
    <div className="pagination">
      <span className="muted small">
        {t('total', { n: total ?? 0 })} · {t('page_of', { page, pages })}
      </span>
      <button type="button" className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t('prev')}
      </button>
      <button type="button" className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('next')}
      </button>
    </div>
  );
}

/** Бор кардани маълумот бо ҳолатҳои loading/error ва reload. */
export function useLoad(loader, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loaderRef.current();
      setState({ loading: false, data, error: null });
    } catch (error) {
      setState({ loading: false, data: null, error });
    }
  }, []);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...state, reload };
}

let toastTimer = null;
const toastListeners = new Set();

export function toast(message, tone = 'success') {
  for (const listener of toastListeners) listener({ message, tone });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    for (const listener of toastListeners) listener(null);
  }, 3500);
}

export function ToastHost() {
  const [current, setCurrent] = useState(null);
  useEffect(() => {
    toastListeners.add(setCurrent);
    return () => toastListeners.delete(setCurrent);
  }, []);
  if (!current) return null;
  return (
    <div className={`toast ${current.tone}`} role="status">
      {current.message}
    </div>
  );
}

/** Амали хатарнок бо сабаб (ва тасдиқи навъшуда). */
export function ConfirmDialog({ title, description, confirmLabel, danger, requireReason, requireText, onConfirm, onClose }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const invalid = (requireReason && reason.trim().length < 3) || (requireText && typed !== requireText);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ reason: reason.trim(), confirm: typed });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy || invalid} onClick={submit}>
            {confirmLabel ?? t('confirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {description && <p className="muted">{description}</p>}
        {requireReason && (
          <Field label={t('reason')}>
            <input className="input" value={reason} placeholder={t('reason_ph')} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        )}
        {requireText && (
          <Field label={t('delete_confirm_hint', { name: requireText })}>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
        )}
        <ErrorAlert error={error} />
      </div>
    </Modal>
  );
}
