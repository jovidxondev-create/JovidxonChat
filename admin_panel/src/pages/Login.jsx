import { useState } from 'react';
import { ApiError, post } from '../api.js';
import { ErrorAlert, Field } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Login({ onDone }) {
  const { t, lang, setLang } = useI18n();
  const [form, setForm] = useState({ username: '', password: '', totp_code: '' });
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { username: form.username.trim(), password: form.password };
      if (needTotp) body.totp_code = form.totp_code.trim();
      onDone(await post('/auth/login', body));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ADMIN_TOTP_REQUIRED') setNeedTotp(true);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

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
        <h2 style={{ textAlign: 'center' }}>{t('login_title')}</h2>
        <Field label={t('username')}>
          <input
            className="input"
            autoComplete="username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
            autoFocus
          />
        </Field>
        <Field label={t('password')}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </Field>
        {needTotp && (
          <Field label={t('totp_code')}>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={form.totp_code}
              onChange={(e) => setForm({ ...form, totp_code: e.target.value.replace(/\D/g, '') })}
              autoFocus
              required
            />
          </Field>
        )}
        <ErrorAlert error={error} />
        <button type="submit" className="btn primary" disabled={busy}>
          {t('login')}
        </button>
        <div className="row" style={{ justifyContent: 'center' }}>
          <select className="input" style={{ width: 'auto' }} value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="tg">Тоҷикӣ</option>
            <option value="ru">Русский</option>
          </select>
        </div>
      </form>
    </div>
  );
}
