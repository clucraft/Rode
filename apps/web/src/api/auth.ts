import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SettingsView } from '@rode/protocol';
import { api, setCsrfToken } from './client.js';

/*
 * Who is signed in, and the settings the UI needs (units, boat name, night
 * mode schedule). Loaded once at boot; refreshed after login/logout and
 * settings saves.
 */

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'crew';
  totpEnabled: boolean;
}

export interface DeployConfig {
  version: string;
  tilesUrl: string | null;
}

export interface AuthSnapshot {
  loaded: boolean;
  needsSetup: boolean;
  user: User | null;
  settings: SettingsView | null;
  config: DeployConfig | null;
}

let snapshot: AuthSnapshot = {
  loaded: false,
  needsSetup: false,
  user: null,
  settings: null,
  config: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<AuthSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

export async function refreshAuth(): Promise<AuthSnapshot> {
  try {
    const me = await api.get<{ user: User | null; csrfToken: string | null; needsSetup: boolean }>(
      '/api/auth/me',
    );
    setCsrfToken(me.csrfToken);
    let settings: SettingsView | null = null;
    let config: DeployConfig | null = null;
    if (me.user) {
      try {
        [settings, config] = await Promise.all([
          api.get<SettingsView>('/api/settings'),
          api.get<DeployConfig>('/api/config'),
        ]);
      } catch {
        settings = null;
      }
    }
    set({ loaded: true, needsSetup: me.needsSetup, user: me.user, settings, config });
  } catch {
    // Offline: keep whatever we had, but mark loaded so the UI can render.
    set({ loaded: true });
  }
  return snapshot;
}

export async function refreshSettings(): Promise<void> {
  try {
    set({ settings: await api.get<SettingsView>('/api/settings') });
  } catch {
    // keep old
  }
}

export async function logout(): Promise<void> {
  try {
    await api.post('/api/auth/logout');
  } finally {
    setCsrfToken(null);
    set({ user: null, settings: null, config: null });
  }
}

export function useAuth(): AuthSnapshot & { refresh: () => Promise<AuthSnapshot> } {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
  const refresh = useCallback(() => refreshAuth(), []);
  useEffect(() => {
    if (!snapshot.loaded) void refreshAuth();
  }, []);
  return { ...snap, refresh };
}
