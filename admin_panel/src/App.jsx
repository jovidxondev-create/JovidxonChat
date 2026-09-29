import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { get, onUnauthorized, post, setCsrf } from './api.js';
import { Layout } from './components/Layout.jsx';
import { Spinner, ToastHost } from './components/ui.jsx';
import { I18nContext, translate } from './i18n.js';
import { Admins } from './pages/Admins.jsx';
import { Audit } from './pages/Audit.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { GroupDetail, Groups } from './pages/Groups.jsx';
import { Login } from './pages/Login.jsx';
import { Profile } from './pages/Profile.jsx';
import { Reports } from './pages/Reports.jsx';
import { Settings } from './pages/Settings.jsx';
import { Setup } from './pages/Setup.jsx';
import { Sms } from './pages/Sms.jsx';
import { System } from './pages/System.jsx';
import { UserDetail } from './pages/UserDetail.jsx';
import { Users } from './pages/Users.jsx';

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ихтиёрӣ
  }
}

export default function App() {
  const [lang, setLangState] = useState(() => readPref('jc_admin_lang', 'tg'));
  const [theme, setThemeState] = useState(() =>
    readPref('jc_admin_theme', window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
  const [boot, setBoot] = useState({ loading: true, needsSetup: false, admin: null });

  const i18n = useMemo(
    () => ({
      lang,
      t: (key, params) => translate(lang, key, params),
      setLang: (value) => {
        setLangState(value);
        writePref('jc_admin_lang', value);
      },
    }),
    [lang],
  );

  const setTheme = (value) => {
    setThemeState(value);
    writePref('jc_admin_theme', value);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = lang === 'ru' ? 'ru' : 'tg';
  }, [lang]);

  const refresh = useCallback(async () => {
    try {
      const setup = await get('/setup');
      if (setup.needs_setup) {
        setBoot({ loading: false, needsSetup: true, admin: null });
        return;
      }
      const me = await get('/auth/me', { quiet401: true });
      setBoot({ loading: false, needsSetup: false, admin: me.admin });
    } catch {
      setBoot({ loading: false, needsSetup: false, admin: null });
    }
  }, []);

  useEffect(() => {
    refresh();
    return onUnauthorized(() => {
      setCsrf(null);
      setBoot((s) => ({ ...s, admin: null }));
    });
  }, [refresh]);

  const onLoggedIn = (data) => setBoot({ loading: false, needsSetup: false, admin: data.admin });
  const onLogout = async () => {
    try {
      await post('/auth/logout');
    } catch {
      // сессия аллакай тамом
    }
    setCsrf(null);
    setBoot((s) => ({ ...s, admin: null }));
  };

  let content;
  if (boot.loading) {
    content = <Spinner />;
  } else if (boot.needsSetup) {
    content = <Setup onDone={onLoggedIn} />;
  } else if (!boot.admin) {
    content = <Login onDone={onLoggedIn} />;
  } else {
    const admin = boot.admin;
    const can = (permission) => admin.permissions.includes(permission);
    content = (
      <BrowserRouter basename="/admin">
        <Routes>
          <Route element={<Layout admin={admin} onLogout={onLogout} theme={theme} setTheme={setTheme} />}>
            <Route index element={can('dashboard.view') ? <Dashboard /> : <Navigate to="/profile" />} />
            <Route path="users" element={<Users admin={admin} />} />
            <Route path="users/:id" element={<UserDetail admin={admin} />} />
            <Route path="groups" element={<Groups />} />
            <Route path="groups/:id" element={<GroupDetail admin={admin} />} />
            <Route path="reports" element={<Reports admin={admin} />} />
            {can('sms.view') && <Route path="sms" element={<Sms admin={admin} />} />}
            {can('settings.manage') && <Route path="settings" element={<Settings />} />}
            {can('admins.manage') && <Route path="admins" element={<Admins admin={admin} />} />}
            {can('audit.view') && <Route path="audit" element={<Audit />} />}
            <Route path="system" element={<System />} />
            <Route path="profile" element={<Profile admin={admin} onChanged={refresh} />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <I18nContext.Provider value={i18n}>
      {content}
      <ToastHost />
    </I18nContext.Provider>
  );
}
