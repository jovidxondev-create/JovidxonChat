import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, get, patch } from '../api.js';
import { Badge, Card, ErrorAlert, Field, Modal, Pagination, Spinner, StatusBadge, toast, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

const TONES = { open: 'warning', in_review: 'primary', resolved: 'success', rejected: 'neutral' };

export function Reports({ admin }) {
  const { t, lang } = useI18n();
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  const list = useLoad(() => get(`/reports?${new URLSearchParams({ status, page: String(page) })}`), [status, page]);

  return (
    <Card>
      <div className="row" style={{ marginBottom: 14 }}>
        {['open', 'in_review', 'resolved', 'rejected', ''].map((s) => (
          <button
            key={s || 'all'}
            type="button"
            className={`btn small ${status === s ? 'primary' : ''}`}
            onClick={() => {
              setPage(1);
              setStatus(s);
            }}
          >
            {s ? t(`r_${s}`) : t('all')}
          </button>
        ))}
      </div>
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
                    <th>{t('report_reason')}</th>
                    <th>{t('target')}</th>
                    <th>{t('reporter')}</th>
                    <th>{t('comment')}</th>
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
                  {list.data.items.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => setOpenId(r.id)}>
                      <td>{formatDate(r.created_at, lang)}</td>
                      <td>
                        <Badge tone="danger">{t(`reason_${r.reason}`)}</Badge>
                      </td>
                      <td>
                        {r.target_name ?? t('none')} {r.target_reports > 1 && <Badge tone="warning">×{r.target_reports}</Badge>}
                      </td>
                      <td>{r.reporter_name}</td>
                      <td className="small">{r.comment ?? (r.target_message_id ? '💬' : t('none'))}</td>
                      <td>
                        <Badge tone={TONES[r.status]}>{t(`r_${r.status}`)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} perPage={list.data.per_page} total={list.data.total} onPage={setPage} />
          </>
        )
      )}
      {openId && (
        <ReportModal
          id={openId}
          canResolve={admin.permissions.includes('reports.resolve')}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            setOpenId(null);
            list.reload();
          }}
        />
      )}
    </Card>
  );
}

function ReportModal({ id, canResolve, onClose, onChanged }) {
  const { t, lang } = useI18n();
  const detail = useLoad(() => get(`/reports/${id}`), [id]);
  const [note, setNote] = useState('');
  const [action, setAction] = useState('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (status) => {
    setBusy(true);
    setError(null);
    try {
      await patch(`/reports/${id}`, { status, note: note.trim() || undefined, action });
      toast(t('saved'));
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('nav_reports')}
      wide
      onClose={onClose}
      actions={
        canResolve && detail.data ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => submit('in_review')}>
              {t('in_review')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => submit('rejected')}>
              {t('reject')}
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => submit('resolved')}>
              {t('resolve')}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            {t('close')}
          </button>
        )
      }
    >
      {detail.loading && !detail.data && <Spinner />}
      <ErrorAlert error={detail.error ?? error} />
      {detail.data && (
        <div className="stack">
          <dl className="kv">
            <dt>{t('report_reason')}</dt>
            <dd>{t(`reason_${detail.data.report.reason}`)}</dd>
            <dt>{t('comment')}</dt>
            <dd>{detail.data.report.comment ?? t('none')}</dd>
            <dt>{t('time')}</dt>
            <dd>{formatDate(detail.data.report.created_at, lang)}</dd>
            <dt>{t('reporter')}</dt>
            <dd>{detail.data.reporter && <Link to={`/users/${detail.data.reporter.id}`}>{detail.data.reporter.display_name}</Link>}</dd>
            <dt>{t('target')}</dt>
            <dd>
              {detail.data.target ? (
                <>
                  <Link to={`/users/${detail.data.target.id}`}>{detail.data.target.display_name}</Link> <StatusBadge status={detail.data.target.status} />
                </>
              ) : (
                t('none')
              )}
            </dd>
            {detail.data.report.resolution_note && (
              <>
                <dt>{t('note')}</dt>
                <dd>{detail.data.report.resolution_note}</dd>
              </>
            )}
          </dl>
          {detail.data.message && (
            <div className="card" style={{ boxShadow: 'none' }}>
              <h3>{t('reported_message')}</h3>
              {detail.data.message.is_deleted ? (
                <Badge tone="neutral">{t('deleted')}</Badge>
              ) : (
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{detail.data.message.body || detail.data.message.preview}</p>
              )}
              {detail.data.message.attachment?.kind === 'image' && !detail.data.message.is_deleted && (
                <img
                  src={`/api/v1/admin/media/${detail.data.message.attachment.id}/thumb`}
                  alt=""
                  style={{ maxWidth: 240, borderRadius: 12, marginTop: 8 }}
                />
              )}
              <div className="muted small">{formatDate(detail.data.message.created_at, lang)}</div>
            </div>
          )}
          {canResolve && (
            <>
              <Field label={t('actions')}>
                <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="none">{t('none')}</option>
                  {detail.data.message && !detail.data.message.is_deleted && <option value="delete_message">{t('delete_message_too')}</option>}
                  {detail.data.target?.status === 'active' && <option value="suspend_user">{t('suspend_user_too')}</option>}
                </select>
              </Field>
              <Field label={t('note')}>
                <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              </Field>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
