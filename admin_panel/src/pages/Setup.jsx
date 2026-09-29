import { useState } from 'react';
import { post } from '../api.js';
import { ErrorAlert, Field, useFieldError } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Setup({ onDone }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ setup_code: '', username: '', display_name: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fieldError = useFieldError(error);
  const mismatch = form.confirm !== '' && form.password !== form.confirm;

  const submit = async (event) => {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      onDone(
        await post('/setup', {
          setup_code: form.setup_code.trim(),
          username: form.username.trim(),
          display_name: form.display_name.trim(),
          password: form.password,
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  return (
    <div className="auth-screen">
      <form className="card auth-card stack" onSubmit={submit}>
        <div className="brand">
          <img src="/admin/favicon.svg" alt="" />
          <div>
            {t('app_name')}
            <small>{t('admin_panel')}</small>
          </div>
        </div>
        <h2 style={{ textAlign: 'center' }}>{t('setup_title')}</h2>
        <div className="alert info">{t('setup_hint')}</div>
        <Field label={t('setup_code')} error={fieldError('setup_code')}>
          <input className="input mono" value={form.setup_code} onChange={set('setup_code')} required autoFocus />
        </Field>
        <Field label={t('username')} error={fieldError('username')}>
          <input className="input" autoComplete="username" value={form.username} onChange={set('username')} required minLength={3} />
        </Field>
        <Field label={t('display_name')}>
          <input className="input" value={form.display_name} onChange={set('display_name')} />
        </Field>
        <Field label={t('password')} hint={t('password_rules')} error={fieldError('password')}>
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={10} />
        </Field>
        <Field label={t('password_confirm')} error={mismatch ? t('passwords_mismatch') : null}>
          <input className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        </Field>
        <ErrorAlert error={error} />
        <button type="submit" className="btn primary" disabled={busy || mismatch}>
          {t('setup_submit')}
        </button>
      </form>
    </div>
  );
}
