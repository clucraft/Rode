import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useAuth } from './api/auth.js';
import { store } from './api/store.js';
import { setNightSchedule, useTheme } from './lib/theme.js';
import { Shell } from './components/Shell.jsx';
import { Login, Setup } from './screens/Auth.jsx';
import { Watch } from './screens/Watch.jsx';
import { Now } from './screens/Now.jsx';
import { Traffic } from './screens/Traffic.jsx';
import { History, SessionDetail } from './screens/History.jsx';
import {
  About,
  BoatGeometry,
  Display,
  SettingsIndex,
  SettingsLayout,
  Source,
  Thresholds,
} from './screens/Settings.jsx';
import { Diagnostics, Security, Tokens, Users, Zones } from './screens/SettingsAdmin.jsx';
import { Notifications } from './screens/Notifications.jsx';
import { Imagery } from './screens/Imagery.jsx';

/*
 * Routing and the auth gate. Order of gates: setup wizard (no admin yet) →
 * sign-in → the app. The live store starts only once signed in.
 */

export function App() {
  const auth = useAuth();
  useTheme();

  useEffect(() => {
    if (auth.settings) setNightSchedule(auth.settings.nightMode);
  }, [auth.settings]);

  useEffect(() => {
    if (auth.user) store.start();
    else store.stop();
  }, [auth.user]);

  if (!auth.loaded) {
    return (
      <div className="auth-shell">
        <p className="muted">Connecting to the boat…</p>
      </div>
    );
  }
  if (auth.needsSetup) return <Setup />;
  if (!auth.user) return <Login />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Watch />} />
          <Route path="now" element={<Now />} />
          <Route path="traffic" element={<Traffic />} />
          <Route path="history" element={<History />} />
          <Route path="history/:id" element={<SessionDetail />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<SettingsIndex />} />
            <Route path="thresholds" element={<Thresholds />} />
            <Route path="boat" element={<BoatGeometry />} />
            <Route path="display" element={<Display />} />
            <Route path="source" element={<Source />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="zones" element={<Zones />} />
            <Route path="imagery" element={<Imagery />} />
            <Route path="users" element={<Users />} />
            <Route path="security" element={<Security />} />
            <Route path="tokens" element={<Tokens />} />
            <Route path="diagnostics" element={<Diagnostics />} />
            <Route path="about" element={<About />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
