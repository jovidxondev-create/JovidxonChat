import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate, formatNumber, get } from '../api.js';
import { Card, ErrorAlert, Pagination, Spinner, StatusBadge, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Users() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(
    () => get(`/users?${new URLSearchParams({ q: applied, status, page: String(page), per_page: '25' })}`),
    [applied, status, page],
  );

  const submit = (event) => {
    event.preventDefault();
    setPage(1);
    setApplied(query.trim());
  };

  return (
    <Card>
      <form className="row" onSubmit={submit} style={{ marginBottom: 14 }}>
        <input className="input" style={{ flex: '1 1 260px' }} placeholder={t('search_users_ph')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <select
          className="input"
          style={{ width: 'auto' }}
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
        >
          <option value="">{t('all')}</option>
          <option value="active">{t('status_active')}</option>
          <option value="suspended">{t('status_suspended')}</option>
          <option value="deleted">{t('status_deleted')}</option>
        </select>
        <button type="submit" className="btn primary">
          {t('search')}
        </button>
      </form>
      <ErrorAlert error={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        list.data && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('display_name')}</th>
                    <th>{t('username')}</th>
                    <th>{t('phone')}</th>
                    <th>{t('status')}</th>
                    <th>{t('messages')}</th>
                    <th>{t('last_seen')}</th>
                    <th>{t('created_at')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        {t('empty')}
                      </td>
                    </tr>
                  )}
                  {list.data.items.map((user) => (
                    <tr key={user.id} className="clickable" onClick={() => navigate(`/users/${user.id}`)}>
                      <td>{user.display_name || <span className="muted">{t('none')}</span>}</td>
                      <td>{user.username ? `@${user.username}` : t('none')}</td>
                      <td className="mono">{user.phone || t('none')}</td>
                      <td>
                        <StatusBadge status={user.status} />
                      </td>
                      <td>{formatNumber(user.messages_count)}</td>
                      <td>{formatDate(user.last_seen_at, lang)}</td>
                      <td>{formatDate(user.created_at, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} perPage={list.data.per_page} total={list.data.total} onPage={setPage} />
          </>
        )
      )}
    </Card>
  );
}
