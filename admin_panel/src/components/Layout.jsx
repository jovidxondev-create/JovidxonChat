import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useI18n } from '../i18n.js';

const NAV = [
  { to: '/', key: 'nav_dashboard', permission: 'dashboard.view', icon: '◧' },
  { to: '/users', key: 'nav_users', permission: 'users.view', icon: '👤' },
  { to: '/groups', key: 'nav_groups', permission: 'groups.view', icon: '👥' },
  { to: '/reports', key: 'nav_reports', permission: 'reports.view', icon: '⚑' },
  { to: '/sms', key: 'nav_sms', permission: 'sms.view', icon: '✉' },
  { to: '/settings', key: 'nav_settings', permission: 'settings.manage', icon: '⚙' },
  { to: '/admins', key: 'nav_admins', permission: 'admins.manage', icon: '🛡' },
  { to: '/audit', key: 'nav_audit', permission: 'audit.view', icon: '☰' },
  { to: '/system', key: 'nav_system', permission: 'system.view', icon: '⛭' },
  { to: '/profile', key: 'nav_profile', permission: null, icon: '🔑' },
];

export function Layout({ admin, onLogout, theme, setTheme }) {
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const items = NAV.filter((item) => !item.permission || admin.permissions.includes(item.permission));
  const current = items.find((item) => (item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)));

  return (
    <div className="layout">
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="brand">
          <img src="/admin/favicon.svg" alt="" />
          <div>
            {t('app_name')}
            <small>{t('admin_panel')}</small>
          </div>
        </div>
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <span aria-hidden="true">{item.icon}</span>
            {t(item.key)}
          </NavLink>
        ))}
        <div className="sidebar-footer" onClick={(e) => e.stopPropagation()}>
          <div className="small muted">
            {admin.display_name || admin.username} · {t(`role_${admin.role}`)}
          </div>
          <div className="row">
            <select className="input" value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t('language')}>
              <option value="tg">Тоҷикӣ</option>
              <option value="ru">Русский</option>
            </select>
            <button type="button" className="btn small" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t('theme')}>
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
          <button type="button" className="btn" onClick={onLogout}>
            {t('logout')}
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <div className="row">
            <button type="button" className="btn small mobile-menu" onClick={() => setOpen(true)} aria-label="menu">
              ☰
            </button>
            <h1 style={{ margin: 0 }}>{current ? t(current.key) : ''}</h1>
          </div>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
