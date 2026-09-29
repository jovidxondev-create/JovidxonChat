import { useEffect, useState } from 'react';
import { get, patch } from '../api.js';
import { Badge, Card, ErrorAlert, Spinner, Switch, toast, useFieldError, useLoad } from '../components/ui.jsx';
import { useI18n } from '../i18n.js';

const GROUPS = ['general', 'sms', 'auth', 'media', 'chat', 'calls', 'push'];
const GROUP_TITLE = {
  general: 'settings_general',
  sms: 'settings_sms',
  auth: 'settings_auth',
  media: 'settings_media',
  chat: 'settings_chat',
  calls: 'settings_calls',
  push: 'settings_push',
};

/** Танзимоти барнома дар база. Махфиҳо танҳо навишта мешаванд (қимати ҳозира пӯшида). */
export function Settings() {
  const { t } = useI18n();
  const load = useLoad(() => get('/settings'), []);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fieldError = useFieldError(error);

  useEffect(() => {
    setDraft({});
  }, [load.data]);

  if (load.loading && !load.data) return <Spinner />;
  if (load.error) return <ErrorAlert error={load.error} />;
  const settings = load.data.settings;

  const change = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const current = (s) => (Object.hasOwn(draft, s.key) ? draft[s.key] : s.value);
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const changes = {};
      for (const [key, value] of Object.entries(draft)) {
        const def = settings.find((s) => s.key === key);
        if (def.secret && value === '') continue;
        changes[key] = def.type === 'list' && typeof value === 'string' ? value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean) : value;
      }
      await patch('/settings', { settings: changes });
      toast(t('saved'));
      await load.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const resetKey = async (key) => {
    setBusy(true);
    setError(null);
    try {
      await patch('/settings', { settings: { [key]: null } });
      toast(t('saved'));
      await load.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const renderInput = (s) => {
    const value = current(s);
    if (s.type === 'bool') return <Switch checked={value} onChange={(v) => change(s.key, v)} />;
    if (s.type === 'enum') {
      return (
        <select className="input" value={value} onChange={(e) => change(s.key, e.target.value)}>
          {s.values.map((v) => (
            <option key={v} value={v}>
              {v || t('none')}
            </option>
          ))}
        </select>
      );
    }
    if (s.type === 'int') {
      return (
        <input
          className="input"
          type="number"
          min={s.min ?? undefined}
          max={s.max ?? undefined}
          value={value}
          onChange={(e) => change(s.key, e.target.value === '' ? '' : Number(e.target.value))}
        />
      );
    }
    if (s.type === 'list') {
      return (
        <textarea
          className="input"
          rows={2}
          value={Array.isArray(value) ? value.join('\n') : value}
          placeholder={t('list_hint')}
          onChange={(e) => change(s.key, e.target.value)}
        />
      );
    }
    if (s.secret) {
      const Tag = s.type === 'json' || s.key === 'otp_test_numbers' ? 'textarea' : 'input';
      return (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <Badge tone={s.is_set ? 'success' : 'neutral'}>{s.is_set ? `${t('secret_set')} ${s.value}` : t('secret_not_set')}</Badge>
          </div>
          <Tag
            className="input mono"
            type={Tag === 'input' ? 'password' : undefined}
            autoComplete="off"
            placeholder={t('secret_ph')}
            value={Object.hasOwn(draft, s.key) ? draft[s.key] : ''}
            onChange={(e) => change(s.key, e.target.value)}
          />
        </div>
      );
    }
    return <input className="input" value={value ?? ''} onChange={(e) => change(s.key, e.target.value)} />;
  };

  return (
    <div className="stack">
      <ErrorAlert error={error} />
      {GROUPS.map((group) => (
        <Card key={group} title={t(GROUP_TITLE[group])} className="settings-group">
          {settings
            .filter((s) => s.group === group)
            .map((s) => (
              <div key={s.key} className="setting-row">
                <div>
                  <div style={{ fontWeight: 600 }}>{t(`s_${s.key}`)}</div>
                  <div className="muted small mono">{s.key}</div>
                  <Badge tone={s.source === 'db' ? 'primary' : 'neutral'}>{t(`source_${s.source}`)}</Badge>
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  {renderInput(s)}
                  {fieldError(s.key) && <div className="error small">{fieldError(s.key)}</div>}
                  {s.source === 'db' && (
                    <button type="button" className="btn small ghost" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => resetKey(s.key)}>
                      {s.secret ? t('secret_clear') : t('reset_default')}
                    </button>
                  )}
                </div>
              </div>
            ))}
        </Card>
      ))}
      <div className="row" style={{ position: 'sticky', bottom: 16, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" disabled={!dirty || busy} onClick={() => setDraft({})}>
          {t('cancel')}
        </button>
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>
          {t('save')}
        </button>
      </div>
    </div>
  );
}
