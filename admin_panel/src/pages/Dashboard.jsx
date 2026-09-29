import { formatBytes, formatNumber, get } from '../api.js';
import { BarChart } from '../components/BarChart.jsx';
import { Card, ErrorAlert, Spinner, Stat, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

export function Dashboard() {
  const { t } = useI18n();
  const stats = useLoad(() => get('/stats'), []);
  const daily = useLoad(() => get('/stats/daily?days=14'), []);

  if (stats.loading && !stats.data) return <Spinner />;
  if (stats.error) return <ErrorAlert error={stats.error} />;
  const s = stats.data;

  return (
    <div className="stack">
      <div className="grid stats">
        <Stat label={t('dash_users')} value={formatNumber(s.users.total)} sub={`${t('dash_new_today')}: ${formatNumber(s.users.new_today)}`} />
        <Stat label={t('dash_active_24h')} value={formatNumber(s.users.active_24h)} sub={`${t('dash_active_7d')}: ${formatNumber(s.users.active_7d)}`} />
        <Stat label={t('dash_messages_today')} value={formatNumber(s.messages.today)} sub={`${t('dash_messages')}: ${formatNumber(s.messages.total)}`} />
        <Stat label={t('dash_online')} value={formatNumber(s.realtime.connections)} sub={`${t('dash_sessions')}: ${formatNumber(s.sessions.active)}`} />
        <Stat label={t('dash_groups')} value={formatNumber(s.chats.groups)} sub={`${t('dash_private')}: ${formatNumber(s.chats.private)}`} />
        <Stat label={t('dash_reports_open')} value={formatNumber(s.reports.open)} sub={`${t('dash_suspended')}: ${formatNumber(s.users.suspended)}`} />
        <Stat
          label={t('dash_sms_today')}
          value={formatNumber(s.sms.sent_today)}
          sub={`${formatNumber(s.sms.failed_today)} ${t('dash_sms_failed')} · 30d: ${formatNumber(s.sms.sent_30d)}`}
        />
        <Stat label={t('dash_media')} value={formatBytes(s.media.bytes)} sub={`${formatNumber(s.media.count)} файл`} />
        <Stat label={t('dash_db_size')} value={formatBytes(s.database.size_bytes)} />
        <Stat label={t('dash_stories')} value={formatNumber(s.stories.live)} sub={`${t('dash_calls_today')}: ${formatNumber(s.calls.today)}`} />
        <Stat label={t('dash_push')} value={formatNumber(s.push.devices)} sub={s.push.enabled ? 'FCM ✓' : 'FCM —'} />
      </div>
      <div className="grid two">
        <Card title={t('dash_chart_messages')}>{daily.data ? <BarChart data={daily.data.days} valueKey="messages" /> : <Spinner />}</Card>
        <Card title={t('dash_chart_users')}>{daily.data ? <BarChart data={daily.data.days} valueKey="new_users" /> : <Spinner />}</Card>
      </div>
    </div>
  );
}
