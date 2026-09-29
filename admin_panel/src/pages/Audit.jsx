import { useState } from 'react';
import { formatDate, get } from '../api.js';
import { Badge, Card, ErrorAlert, Pagination, Spinner, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Audit() {
  const { t, lang } = useI18n();
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => get(`/audit?${new URLSearchParams({ action: applied, page: String(page), per_page: '50' })}`), [applied, page]);

  return (
    <Card>
      <form
        className="row"
        style={{ marginBottom: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied(action.trim());
        }}
      >
        <input className="input" style={{ flex: '1 1 240px' }} placeholder={t('audit_filter_ph')} value={action} onChange={(e) => setAction(e.target.value)} />
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
                    <th>{t('time')}</th>
                    <th>{t('audit_actor')}</th>
                    <th>{t('audit_action')}</th>
                    <th>{t('audit_target')}</th>
                    <th>{t('audit_details')}</th>
                    <th>IP</th>
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
                  {list.data.items.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDate(row.created_at, lang)}</td>
                      <td>{row.actor}</td>
                      <td>
                        <Badge>{row.action}</Badge>
                      </td>
                      <td className="mono">{row.target ?? t('none')}</td>
                      <td className="mono">{row.details ? JSON.stringify(row.details) : t('none')}</td>
                      <td className="mono">{row.ip ?? t('none')}</td>
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
