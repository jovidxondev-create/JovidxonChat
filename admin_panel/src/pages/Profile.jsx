import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { post } from '../api.js';
import { Badge, Card, ErrorAlert, Field, toast, useFieldError } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Profile({ admin, onChanged }) {
  const { t } = useI18n();
  return (
    <div className="grid two">
      <PasswordCard />
      <TotpCard enabled={admin.totp_enabled} onChanged={onChanged} t={t} />
    </div>
  );
}

function PasswordCard() {
  const { t } = useI18n();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fieldError = useFieldError(error);
  const mismatch = form.confirm !== '' && form.new_password !== form.confirm;

  const submit = async (event) => {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await post('/me/password', { current_password: form.current_password, new_password: form.new_password });
      setForm({ current_password: '', new_password: '', confirm: '' });
      toast(t('saved'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('profile_password')}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('current_password')} error={fieldError('current_password')}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={form.current_password}
            onChange={(e) => setForm({ ...form, current_password: e.target.value })}
            required
          />
        </Field>
        <Field label={t('new_password')} hint={t('password_rules')} error={fieldError('new_password')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.new_password}
            onChange={(e) => setForm({ ...form, new_password: e.target.value })}
            required
            minLength={10}
          />
        </Field>
        <Field label={t('password_confirm')} error={mismatch ? t('passwords_mismatch') : null}>
          <input className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />
        </Field>
        <ErrorAlert error={error} />
        <button type="submit" className="btn primary" disabled={busy || mismatch}>
          {t('save')}
        </button>
      </form>
    </Card>
  );
}

function TotpCard({ enabled, onChanged, t }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!setup) return;
    QRCode.toDataURL(setup.otpauth_url, { margin: 1, width: 220 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [setup]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('profile_totp')}>
      <div className="stack">
        <div>{enabled ? <Badge tone="success">{t('totp_on')}</Badge> : <Badge tone="warning">{t('totp_off')}</Badge>}</div>
        {!enabled && !setup && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => setSetup(await post('/me/totp/setup')))}>
            {t('totp_setup')}
          </button>
        )}
        {!enabled && setup && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {t('totp_scan')}
            </p>
            {qr && <img className="qr" src={qr} alt="QR" />}
            <Field label={t('totp_secret')}>
              <input className="input mono" value={setup.secret} readOnly />
            </Field>
            <Field label={t('totp_code')}>
              <input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <button
              type="button"
              className="btn primary"
              disabled={busy || code.length !== 6}
              onClick={() =>
                run(async () => {
                  await post('/me/totp/enable', { code });
                  toast(t('saved'));
                  setSetup(null);
                  await onChanged();
                })
              }
            >
              {t('confirm')}
            </button>
          </>
        )}
        {enabled && (
          <>
            <Field label={t('password')}>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <button
              type="button"
              className="btn danger"
              disabled={busy || !password}
              onClick={() =>
                run(async () => {
                  await post('/me/totp/disable', { password });
                  toast(t('saved'));
                  setPassword('');
                  await onChanged();
                })
              }
            >
              {t('totp_disable')}
            </button>
          </>
        )}
        <ErrorAlert error={error} />
      </div>
    </Card>
  );
}
