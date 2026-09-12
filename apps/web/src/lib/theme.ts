import { useEffect, useSyncExternalStore } from 'react';

/*
 * Day / night palettes. Night mode is a hard requirement, not a theme toggle:
 * a deep red-shifted palette that preserves dark adaptation, engaging on a
 * schedule (from settings) or by hand. The manual choice is per device and
 * wins over the schedule until the next schedule boundary.
 */

export type ThemeMode = 'auto' | 'day' | 'night';
export type Theme = 'day' | 'night';

const KEY = 'rode:theme-mode';

interface ThemeState {
  mode: ThemeMode;
  theme: Theme;
  schedule: { from: string; to: string; enabled: boolean };
}

let state: ThemeState = {
  mode: (readPref() as ThemeMode | null) ?? 'auto',
  theme: 'day',
  schedule: { from: '20:00', to: '06:00', enabled: true },
};
const listeners = new Set<() => void>();

function readPref(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function minutesOf(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** True when `now` falls in the [from, to) window, which may cross midnight. */
export function inNightWindow(now: Date, from: string, to: string): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = minutesOf(from);
  const b = minutesOf(to);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

function resolve(): Theme {
  if (state.mode === 'day' || state.mode === 'night') return state.mode;
  if (!state.schedule.enabled) return 'day';
  return inNightWindow(new Date(), state.schedule.from, state.schedule.to) ? 'night' : 'day';
}

function apply(): void {
  const theme = resolve();
  if (theme !== state.theme) {
    state = { ...state, theme };
    emit();
  }
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'night' ? '#000000' : '#0b0f14');
}

export function setThemeMode(mode: ThemeMode): void {
  state = { ...state, mode };
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // ignore
  }
  apply();
  emit();
}

export function setNightSchedule(schedule: {
  from: string;
  to: string;
  mode: 'auto' | 'on' | 'off';
}): void {
  state = {
    ...state,
    schedule: { from: schedule.from, to: schedule.to, enabled: schedule.mode !== 'off' },
  };
  if (schedule.mode === 'on' && state.mode === 'auto') state = { ...state, mode: 'night' };
  apply();
  emit();
}

let timer: number | null = null;
export function startThemeClock(): void {
  apply();
  if (timer) return;
  timer = window.setInterval(apply, 30_000);
}

export function useTheme(): ThemeState {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
  useEffect(() => startThemeClock(), []);
  return snap;
}
