import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, formatDate, formatNumber, get } from '../api.js';
import { Badge, Card, ConfirmDialog, ErrorAlert, Pagination, Spinner, StatusBadge, toast, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Groups() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => get(`/groups?${new URLSearchParams({ q: applied, page: String(page) })}`), [applied, page]);

  return (
    <Card>
      <form
        className="row"
        style={{ marginBottom: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied(query.trim());
        }}
      >
        <input className="input" style={{ flex: '1 1 260px' }} placeholder={t('search_groups_ph')} value={query} onChange={(e) => setQuery(e.target.value)} />
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
                    <th>{t('group_name')}</th>
                    <th>{t('owner')}</th>
                    <th>{t('member_count')}</th>
                    <th>{t('messages')}</th>
                    <th>{t('created_at')}</th>
                    <th>{t('status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        {t('empty')}
                      </td>
                    </tr>
                  )}
                  {list.data.items.map((g) => (
                    <tr key={g.id} className="clickable" onClick={() => navigate(`/groups/${g.id}`)}>
                      <td>{g.name}</td>
                      <td>{g.owner_name ?? t('none')}</td>
                      <td>{formatNumber(g.member_count)}</td>
                      <td>{formatNumber(g.messages_count)}</td>
                      <td>{formatDate(g.created_at, lang)}</td>
                      <td>{g.deleted_at ? <Badge tone="neutral">{t('deleted')}</Badge> : <Badge tone="success">✓</Badge>}</td>
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

export function GroupDetail({ admin }) {
  const { t, lang } = useI18n();
  const { id } = useParams();
  const detail = useLoad(() => get(`/groups/${id}`), [id]);
  const [confirm, setConfirm] = useState(false);

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) return <ErrorAlert error={detail.error} />;
  const { group, members } = detail.data;

  return (
    <div className="stack">
      <div className="row between">
        <Link to="/groups" className="btn small ghost">
          ← {t('back')}
        </Link>
        {admin.permissions.includes('groups.delete') && !group.deleted_at && (
          <button type="button" className="btn danger" onClick={() => setConfirm(true)}>
            {t('delete_group')}
          </button>
        )}
      </div>
      <Card title={group.name}>
        <dl className="kv">
          <dt>ID</dt>
          <dd className="mono">{group.id}</dd>
          <dt>{t('comment')}</dt>
          <dd>{group.description || t('none')}</dd>
          <dt>{t('messages')}</dt>
          <dd>{formatNumber(group.messages_count)}</dd>
          <dt>{t('created_at')}</dt>
          <dd>{formatDate(group.created_at, lang)}</dd>
          {group.deleted_at && (
            <>
              <dt>{t('deleted')}</dt>
              <dd>{formatDate(group.deleted_at, lang)}</dd>
            </>
          )}
        </dl>
      </Card>
      <Card title={`${t('members')} (${members.length})`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('display_name')}</th>
                <th>{t('username')}</th>
                <th>{t('role')}</th>
                <th>{t('status')}</th>
                <th>{t('created_at')}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={`/users/${m.id}`}>{m.display_name || t('none')}</Link>
                  </td>
                  <td>{m.username ? `@${m.username}` : t('none')}</td>
                  <td>
                    <Badge tone={m.role === 'member' ? 'neutral' : 'primary'}>{m.role}</Badge>
                  </td>
                  <td>
                    <StatusBadge status={m.status} />
                  </td>
                  <td>{formatDate(m.joined_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {confirm && (
        <ConfirmDialog
          title={t('delete_group')}
          danger
          requireReason
          onConfirm={async ({ reason }) => {
            await del(`/groups/${id}`, { reason });
            toast(t('saved'));
            await detail.reload();
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
