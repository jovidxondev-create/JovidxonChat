import { formatBytes, formatDate, get } from '../api.js';
import { Badge, Card, ErrorAlert, Spinner, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h}h ${m}m`;
}

export function System() {
  const { t, lang } = useI18n();
  const load = useLoad(() => get('/system'), []);
  if (load.loading && !load.data) return <Spinner />;
  if (load.error) return <ErrorAlert error={load.error} />;
  const s = load.data;
  const flag = (ok) => <Badge tone={ok ? 'success' : 'danger'}>{ok ? t('ok') : t('not_ok')}</Badge>;

  return (
    <div className="grid two">
      <Card title={t('nav_system')} actions={<button type="button" className="btn small" onClick={load.reload}>↻</button>}>
        <dl className="kv">
          <dt>{t('system_version')}</dt>
          <dd>
            {s.version} · Node {s.node} · {s.env}
          </dd>
          <dt>Instance</dt>
          <dd className="mono">{s.instance_id}</dd>
          <dt>{t('system_uptime')}</dt>
          <dd>{duration(s.uptime_seconds)}</dd>
          <dt>{t('system_memory')}</dt>
          <dd>
            RSS {formatBytes(s.memory.rss)} · heap {formatBytes(s.memory.heap_used)}
          </dd>
          <dt>{t('system_realtime')}</dt>
          <dd>
            {s.realtime.connections} · {t('system_listener')} {flag(s.realtime.listener)}
          </dd>
          {s.proxy && (
            <>
              <dt>{t('system_proxy')}</dt>
              <dd>
                {flag(s.proxy.ok)}{' '}
                <span className="muted small">
                  XFF: {s.proxy.xff_entries} · CF: {s.proxy.cf_header ? t('yes') : t('no')}
                </span>
              </dd>
            </>
          )}
        </dl>
      </Card>
      <Card title={t('system_db')}>
        <dl className="kv">
          <dt>{t('system_version')}</dt>
          <dd>{s.database.version}</dd>
          <dt>{t('dash_db_size')}</dt>
          <dd>{formatBytes(s.database.size_bytes)}</dd>
          <dt>{t('system_migrations')}</dt>
          <dd>{s.database.pending_migrations.length === 0 ? flag(true) : s.database.pending_migrations.join(', ')}</dd>
          <dt>{t('time')}</dt>
          <dd>{formatDate(s.database.time, lang)}</dd>
        </dl>
      </Card>
      <Card title={t('system_features')}>
        <dl className="kv">
          <dt>SMS</dt>
          <dd>
            <Badge>{s.features.sms_driver}</Badge>
          </dd>
          <dt>Google</dt>
          <dd>{flag(s.features.google_configured)}</dd>
          <dt>Push (FCM)</dt>
          <dd>{flag(s.features.push_enabled)}</dd>
          <dt>{t('s_calls_enabled')}</dt>
          <dd>{flag(s.features.calls_enabled)}</dd>
          <dt>{t('s_registration_enabled')}</dt>
          <dd>{flag(s.features.registration_enabled)}</dd>
          <dt>{t('s_maintenance_mode')}</dt>
          <dd>
            <Badge tone={s.features.maintenance_mode ? 'warning' : 'neutral'}>{s.features.maintenance_mode ? t('yes') : t('no')}</Badge>
          </dd>
        </dl>
      </Card>
      <Card title={t('system_maintenance')}>
        {s.maintenance ? (
          <>
            <div className="muted small">{formatDate(s.maintenance.last_run, lang)}</div>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {JSON.stringify(s.maintenance.results, null, 1)}
            </pre>
          </>
        ) : (
          <span className="muted">{t('none')}</span>
        )}
      </Card>
    </div>
  );
}
