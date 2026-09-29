import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { del, formatBytes, formatDate, get, post } from '../api.js';
import { Badge, Card, ConfirmDialog, ErrorAlert, Spinner, StatusBadge, toast, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function UserDetail({ admin }) {
  const { t, lang } = useI18n();
  const { id } = useParams();
  const detail = useLoad(() => get(`/users/${id}`), [id]);
  const [dialog, setDialog] = useState(null);
  const can = (p) => admin.permissions.includes(p);

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) return <ErrorAlert error={detail.error} />;
  const { user, sessions, devices, stats, oauth } = detail.data;
  const deleteName = user.username || user.display_name || user.id;

  const act = (config) => setDialog(config);
  const done = async () => {
    toast(t('saved'));
    await detail.reload();
  };

  return (
    <div className="stack">
      <div className="row between">
        <Link to="/users" className="btn small ghost">
          ← {t('back')}
        </Link>
        <div className="row">
          {can('users.moderate') && user.status === 'active' && (
            <button
              type="button"
              className="btn danger"
              onClick={() =>
                act({
                  title: t('suspend'),
                  danger: true,
                  requireReason: true,
                  onConfirm: ({ reason }) => post(`/users/${id}/suspend`, { reason }).then(done),
                })
              }
            >
              {t('suspend')}
            </button>
          )}
          {can('users.moderate') && user.status === 'suspended' && (
            <button type="button" className="btn primary" onClick={() => act({ title: t('unsuspend'), onConfirm: () => post(`/users/${id}/unsuspend`).then(done) })}>
              {t('unsuspend')}
            </button>
          )}
          {can('users.moderate') && user.status !== 'deleted' && (
            <button type="button" className="btn" onClick={() => act({ title: t('logout_all'), onConfirm: () => post(`/users/${id}/logout`).then(done) })}>
              {t('logout_all')}
            </button>
          )}
          {can('users.delete') && user.status !== 'deleted' && (
            <button
              type="button"
              className="btn danger"
              onClick={() =>
                act({
                  title: t('delete_account'),
                  danger: true,
                  requireReason: true,
                  requireText: deleteName,
                  onConfirm: ({ reason, confirm }) => del(`/users/${id}`, { reason, confirm }).then(done),
                })
              }
            >
              {t('delete_account')}
            </button>
          )}
        </div>
      </div>

      <div className="grid two">
        <Card title={t('user_info')}>
          <dl className="kv">
            <dt>ID</dt>
            <dd className="mono">{user.id}</dd>
            <dt>{t('display_name')}</dt>
            <dd>{user.display_name || t('none')}</dd>
            <dt>{t('username')}</dt>
            <dd>{user.username ? `@${user.username}` : t('none')}</dd>
            <dt>{t('phone')}</dt>
            <dd className="mono">{user.phone || t('none')}</dd>
            <dt>{t('status')}</dt>
            <dd>
              <StatusBadge status={user.status} /> {user.status_reason && <span className="muted small">— {user.status_reason}</span>}
            </dd>
            <dt>{t('created_at')}</dt>
            <dd>{formatDate(user.created_at, lang)}</dd>
            <dt>{t('last_seen')}</dt>
            <dd>{formatDate(user.last_seen_at, lang)}</dd>
            {oauth.length > 0 && (
              <>
                <dt>{t('google_accounts')}</dt>
                <dd>{oauth.map((o) => o.email ?? o.provider).join(', ')}</dd>
              </>
            )}
          </dl>
          {user.avatar_media_id && (
            <img
              src={`/api/v1/admin/media/${user.avatar_media_id}/thumb`}
              alt=""
              style={{ width: 96, height: 96, borderRadius: 16, objectFit: 'cover', marginTop: 12 }}
            />
          )}
        </Card>
        <Card title={t('stats')}>
          <dl className="kv">
            <dt>{t('messages')}</dt>
            <dd>{stats.messages}</dd>
            <dt>{t('chats_count')}</dt>
            <dd>{stats.chats}</dd>
            <dt>{t('groups_count')}</dt>
            <dd>{stats.groups}</dd>
            <dt>{t('media_bytes')}</dt>
            <dd>{formatBytes(stats.media_bytes)}</dd>
            <dt>{t('reports_against')}</dt>
            <dd>{stats.reports_against > 0 ? <Badge tone="danger">{stats.reports_against}</Badge> : 0}</dd>
            <dt>{t('reports_by')}</dt>
            <dd>{stats.reports_by}</dd>
            <dt>{t('blocked_by')}</dt>
            <dd>{stats.blocked_by}</dd>
          </dl>
        </Card>
      </div>

      <Card title={t('sessions')}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('devices')}</th>
                <th>{t('status')}</th>
                <th>IP</th>
                <th>{t('created_at')}</th>
                <th>{t('last_seen')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.device_name || s.platform} <span className="muted small">{s.app_version} · {s.auth_method}</span>
                  </td>
                  <td>{s.revoked_at ? <Badge tone="neutral">{t('revoked')}: {s.revoke_reason}</Badge> : <Badge tone="success">✓</Badge>}</td>
                  <td className="mono">{s.ip ?? t('none')}</td>
                  <td>{formatDate(s.created_at, lang)}</td>
                  <td>{formatDate(s.last_active_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t('devices')}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('devices')}</th>
                <th>Push</th>
                <th>{t('language')}</th>
                <th>{t('last_seen')}</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {devices.map((d) => (
                <tr key={d.device_id}>
                  <td>
                    {d.device_name || d.device_id} <span className="muted small">{d.app_version}</span>
                  </td>
                  <td>{d.push ? '✓' : '—'}</td>
                  <td>{d.locale}</td>
                  <td>{formatDate(d.last_active_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {dialog && <ConfirmDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
