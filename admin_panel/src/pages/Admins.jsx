import { useState } from 'react';
import { del, formatDate, get, patch, post } from '../api.js';
import { Badge, Card, ConfirmDialog, ErrorAlert, Field, Modal, Spinner, toast, useFieldError, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

const ROLES = ['super_admin', 'moderator', 'support'];

export function Admins({ admin }) {
  const { t, lang } = useI18n();
  const list = useLoad(() => get('/admins'), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);

  if (list.loading && !list.data) return <Spinner />;
  return (
    <Card
      actions={
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          + {t('admins_new')}
        </button>
      }
    >
      <ErrorAlert error={list.error} />
      {list.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('username')}</th>
                <th>{t('display_name')}</th>
                <th>{t('role')}</th>
                <th>{t('totp')}</th>
                <th>{t('last_login')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.username} {a.id === admin.id && <Badge tone="neutral">you</Badge>}
                  </td>
                  <td>{a.display_name}</td>
                  <td>
                    <Badge tone={a.role === 'super_admin' ? 'primary' : 'neutral'}>{t(`role_${a.role}`)}</Badge>{' '}
                    {a.disabled && <Badge tone="danger">{t('disabled')}</Badge>}
                  </td>
                  <td>{a.totp_enabled ? '✓' : '—'}</td>
                  <td>{formatDate(a.last_login_at, lang)}</td>
                  <td>
                    <div className="row">
                      <button type="button" className="btn small" onClick={() => setEditing(a)}>
                        ✎
                      </button>
                      {a.id !== admin.id && (
                        <button type="button" className="btn small danger" onClick={() => setRemoving(a)}>
                          {t('delete')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <AdminForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
      {editing && (
        <AdminForm
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`${t('delete')}: ${removing.username}`}
          danger
          onConfirm={async () => {
            await del(`/admins/${removing.id}`);
            toast(t('saved'));
            list.reload();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}

function AdminForm({ existing, onClose, onSaved }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    username: existing?.username ?? '',
    display_name: existing?.display_name ?? '',
    role: existing?.role ?? 'support',
    password: '',
    disabled: existing?.disabled ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fieldError = useFieldError(error);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        const body = { role: form.role, display_name: form.display_name, disabled: form.disabled };
        if (form.password) body.password = form.password;
        await patch(`/admins/${existing.id}`, body);
      } else {
        await post('/admins', { username: form.username.trim(), display_name: form.display_name.trim(), role: form.role, password: form.password });
      }
      toast(t('saved'));
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={existing ? existing.username : t('admins_new')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!existing && (
          <Field label={t('username')} error={fieldError('username')}>
            <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={3} />
          </Field>
        )}
        <Field label={t('display_name')}>
          <input className="input" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        </Field>
        <Field label={t('role')} error={fieldError('role')}>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role_${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={existing ? t('reset_password') : t('password')} hint={t('password_rules')} error={fieldError('password')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required={!existing}
            minLength={10}
          />
        </Field>
        {existing && (
          <label className="switch">
            <input type="checkbox" checked={form.disabled} onChange={(e) => setForm({ ...form, disabled: e.target.checked })} />
            <span>{t('disabled')}</span>
          </label>
        )}
        <ErrorAlert error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {existing ? t('save') : t('create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
