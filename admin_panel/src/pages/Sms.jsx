import { useState } from 'react';
import { formatDate, get, post } from '../api.js';
import { Badge, Card, ErrorAlert, Field, Pagination, Spinner, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Sms({ admin }) {
  const { t, lang } = useI18n();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => get(`/sms?${new URLSearchParams({ status, page: String(page) })}`), [status, page]);
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const sendTest = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await post('/sms/test', { phone: phone.trim() }));
      list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="grid two">
        <Card title={t('sms_summary')}>
          {list.data ? (
            <div className="stack">
              <div className="row">
                <span className="muted">{t('sms_driver')}:</span> <Badge>{list.data.driver}</Badge>
                <span className="muted">{t('sms_fallback')}:</span> <Badge tone="neutral">{list.data.fallback_driver || t('none')}</Badge>
              </div>
              <div className="table-wrap">
                <table style={{ minWidth: 0 }}>
                  <tbody>
                    {list.data.summary.map((row) => (
                      <tr key={`${row.driver}-${row.status}`}>
                        <td>{row.driver}</td>
                        <td>
                          <Badge tone={row.status === 'sent' ? 'success' : 'danger'}>{row.status}</Badge>
                        </td>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <Spinner />
          )}
        </Card>
        {admin.permissions.includes('sms.test') && (
          <Card title={t('sms_test')}>
            <form className="stack" onSubmit={sendTest}>
              <p className="muted" style={{ margin: 0 }}>
                {t('sms_test_hint')}
              </p>
              <Field label={t('phone')}>
                <input className="input" placeholder="+992…" value={phone} onChange={(e) => setPhone(e.target.value)} required />
              </Field>
              <ErrorAlert error={error} />
              {result && (
                <div className={`alert ${result.ok ? 'success' : ''}`}>
                  {result.ok ? t('sms_sent_ok', { driver: result.driver }) : t('sms_sent_fail', { error: `${result.driver}: ${result.error}` })}
                </div>
              )}
              <button type="submit" className="btn primary" disabled={busy}>
                {t('sms_send')}
              </button>
            </form>
          </Card>
        )}
      </div>
      <Card
        title={t('nav_sms')}
        actions={['', 'sent', 'failed'].map((s) => (
          <button
            key={s || 'all'}
            type="button"
            className={`btn small ${status === s ? 'primary' : ''}`}
            onClick={() => {
              setPage(1);
              setStatus(s);
            }}
          >
            {s || t('all')}
          </button>
        ))}
      >
        <ErrorAlert error={list.error} />
        {list.data && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('time')}</th>
                    <th>{t('phone')}</th>
                    <th>{t('driver')}</th>
                    <th>{t('status')}</th>
                    <th>{t('error_col')}</th>
                    <th>{t('duration')}</th>
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
                      <td className="mono">{row.phone_masked}</td>
                      <td>
                        {row.driver} <span className="muted small">{row.template}</span>
                      </td>
                      <td>
                        <Badge tone={row.status === 'sent' ? 'success' : 'danger'}>{row.status}</Badge>
                      </td>
                      <td className="mono">{row.error ?? t('none')}</td>
                      <td>{row.duration_ms != null ? `${row.duration_ms} ms` : t('none')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} perPage={list.data.per_page} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
