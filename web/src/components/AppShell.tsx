import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getClaims, logout } from '../auth/cognito';
import { config } from '../config';

const ICON = {
  compose: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  ),
  subscribers: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  send: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  history: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
} as const;

const NAV = [
  { to: '/compose', label: 'Compose', icon: ICON.compose },
  { to: '/subscribers', label: 'Subscribers', icon: ICON.subscribers },
  { to: '/send', label: 'Send', icon: ICON.send },
  { to: '/history', label: 'History', icon: ICON.history },
];

const COLLAPSE_KEY = 'dispatch.sidebar.collapsed';

export function AppShell() {
  const claims = getClaims();
  const { location } = useRouterState();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  });
  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const initials = (claims?.name ?? claims?.email ?? '??')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '›' : '‹'}
        </button>

        {collapsed ? (
          <div className="brand" style={{ justifyContent: 'center', padding: 0 }}>
            <span className="brand-mark" style={{ fontSize: 22 }}>
              {config.brand.prefix.charAt(0).toUpperCase()}<span className="brand-dot" />
            </span>
          </div>
        ) : (
          <>
            <div className="brand">
              <span className="brand-mark" style={{ fontSize: 22 }}>
                {config.brand.prefix}<span className="brand-dot" />
              </span>
            </div>
            <div style={{ padding: '0 6px', marginTop: -14 }}>
              <span className="brand-sub">Dispatch</span>
            </div>
          </>
        )}

        <nav className="nav">
          {!collapsed && <div className="nav-section-label">Workspace</div>}
          {NAV.map((item) => {
            const active = location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`nav-item ${active ? 'active' : ''}`}
                title={collapsed ? item.label : undefined}
                style={collapsed ? { justifyContent: 'center', padding: '8px 0' } : undefined}
              >
                {item.icon}
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer" style={collapsed ? { justifyContent: 'center', padding: 8 } : undefined}>
          <div className="avatar" style={{ width: 28, height: 28, fontSize: 13 }}>
            {initials}
          </div>
          {!collapsed && (
            <div className="stack" style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500 }}>
                {claims?.name ?? claims?.email ?? 'Signed in'}
              </div>
              <button
                className="link-ghost"
                style={{ fontSize: 11, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={logout}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
