import { NavLink, Outlet } from 'react-router';
import { useStore } from '../api/store.js';
import { useAuth } from '../api/auth.js';
import { fmtDuration } from '../lib/format.js';
import { setThemeMode, useTheme } from '../lib/theme.js';

/*
 * App chrome: top bar with the connection strip, bottom tab bar (left rail on
 * wide screens). Deliberately quiet; the Watch screen carries the weight.
 */

const tabs = [
  { to: '/', label: 'Watch', icon: AnchorIcon },
  { to: '/now', label: 'Now', icon: GaugeIcon },
  { to: '/traffic', label: 'Traffic', icon: ShipIcon },
  { to: '/history', label: 'History', icon: ClockIcon },
  { to: '/settings', label: 'Settings', icon: CogIcon },
];

export function Shell() {
  const { state, link, lastMessageAt, rttMs } = useStore();
  const { settings } = useAuth();
  const theme = useTheme();
  const src = state?.source;
  const srcKind = src?.state.kind ?? 'disconnected';
  const gps = state?.watch.live.positionAgeS;
  const gpsOk = gps !== null && gps !== undefined && gps < 10;
  const boatName = settings?.boatName ?? 'Rode';

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">{boatName}</span>
        <div className="strip" aria-label="Connection status">
          <span>
            <span
              className={`dot ${link === 'live' ? 'live' : link === 'connecting' ? 'warn' : 'bad'}`}
              aria-hidden="true"
            />
            {link === 'live'
              ? `link${rttMs !== null ? ` ${rttMs} ms` : ''}`
              : link === 'connecting'
                ? 'connecting…'
                : `offline ${lastMessageAt ? fmtDuration(Date.now() - lastMessageAt) : ''}`}
          </span>
          <span>
            <span
              className={`dot ${srcKind === 'connected' ? 'live' : srcKind === 'connecting' ? 'warn' : 'bad'}`}
              aria-hidden="true"
            />
            {src ? `${src.kind} ${srcKind}` : 'source ?'}
          </span>
          <span>
            <span className={`dot ${gpsOk ? 'live' : 'bad'}`} aria-hidden="true" />
            GPS{' '}
            {gpsOk
              ? 'ok'
              : gps === null || gps === undefined
                ? 'none'
                : `${fmtDuration(gps * 1000)} old`}
          </span>
          <span title="Last successful notification delivery">
            <span
              className={`dot ${state?.health.notificationsLastConfirmedAt && Date.now() - state.health.notificationsLastConfirmedAt < 48 * 3_600_000 ? 'live' : 'warn'}`}
              aria-hidden="true"
            />
            notify{' '}
            {state?.health.notificationsLastConfirmedAt
              ? `ok ${fmtDuration(Date.now() - state.health.notificationsLastConfirmedAt)} ago`
              : 'unconfirmed'}
          </span>
          {state?.time.clockSource && state.time.clockSource !== 'system' ? (
            <span
              className={`pill ${state.time.clockSource === 'gps' ? '' : 'warn'}`}
              title="The box has no trusted system clock"
            >
              {state.time.clockSource === 'gps' ? 'clock from GPS' : 'clock unsynced'}
            </span>
          ) : null}
          {state?.health.unexpectedRestart ? (
            <span className="pill warn" title="The box restarted without a clean shutdown">
              restarted
            </span>
          ) : null}
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="btn quiet small"
          onClick={() => setThemeMode(theme.theme === 'night' ? 'day' : 'night')}
          aria-pressed={theme.theme === 'night'}
          title="Night mode"
        >
          {theme.theme === 'night' ? 'Night' : 'Day'}
          {theme.mode === 'auto' ? ' · auto' : ''}
        </button>
      </header>
      <nav className="nav" aria-label="Main">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === '/'} aria-label={t.label}>
            <t.icon />
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
      <main id="main" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function AnchorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="5" r="2.2" />
      <line x1="12" y1="7.2" x2="12" y2="21" />
      <line x1="7" y1="10" x2="17" y2="10" />
      <path d="M4 14 Q12 24 20 14" />
    </svg>
  );
}
function GaugeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 17 A9 9 0 0 1 20 17" />
      <line x1="12" y1="17" x2="16.5" y2="10" />
      <circle cx="12" cy="17" r="1.4" />
    </svg>
  );
}
function ShipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 15 L5 19 H19 L21 15 Z" />
      <path d="M6 15 V9 H18 V15" />
      <line x1="12" y1="9" x2="12" y2="4" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7 V12 L15.5 14" />
    </svg>
  );
}
function CogIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21 M5.6 5.6 L7.8 7.8 M16.2 16.2 L18.4 18.4 M5.6 18.4 L7.8 16.2 M16.2 7.8 L18.4 5.6" />
    </svg>
  );
}
