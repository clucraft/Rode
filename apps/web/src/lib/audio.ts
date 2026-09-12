import { useSyncExternalStore } from 'react';

/*
 * In-app alarm audio.
 *
 * iOS will not start audio without a user gesture, so arming is an explicit
 * tap ("Enable alarm sound on this device") that creates and resumes the
 * AudioContext. The armed state shown in the UI is the *real* one: whether
 * the context is running right now on this device. A safety app that looks
 * armed but is muted is the worst outcome, so we never fake it.
 *
 * Warning and critical sound different: a two-note chirp every few seconds
 * versus a continuous alternating siren that gets louder on each re-fire.
 */

export type AlarmLevel = 'none' | 'warning' | 'critical';

interface AudioState {
  /** Context exists and is running: sound will actually play. */
  armed: boolean;
  /** User armed it once on this device; shown as "tap to re-arm" after reload. */
  wasArmed: boolean;
  level: AlarmLevel;
  playing: boolean;
  /** 0–1 */
  volume: number;
}

const KEY = 'rode:audio-armed';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let loop: number | null = null;
let state: AudioState = {
  armed: false,
  wasArmed: readFlag(),
  level: 'none',
  playing: false,
  volume: 0.6,
};
const listeners = new Set<() => void>();

function readFlag(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function set(patch: Partial<AudioState>): void {
  state = { ...state, ...patch };
  emit();
}

/** Must be called from a user gesture. Returns the resulting armed state. */
export async function armAudio(): Promise<boolean> {
  try {
    ctx ??= new AudioContext();
    if (ctx.state !== 'running') await ctx.resume();
    master ??= ctx.createGain();
    master.gain.value = state.volume;
    master.connect(ctx.destination);
    const armed = ctx.state === 'running';
    try {
      localStorage.setItem(KEY, armed ? '1' : '0');
    } catch {
      // ignore
    }
    set({ armed, wasArmed: armed });
    if (armed) beep(880, 0.08, 0.3);
    ctx.onstatechange = () => set({ armed: ctx?.state === 'running' });
    return armed;
  } catch {
    set({ armed: false });
    return false;
  }
}

export function disarmAudio(): void {
  stopLoop();
  try {
    localStorage.setItem(KEY, '0');
  } catch {
    // ignore
  }
  void ctx?.suspend();
  set({ armed: false, wasArmed: false, playing: false });
}

export function setVolume(v: number): void {
  const volume = Math.min(1, Math.max(0, v));
  if (master) master.gain.value = volume;
  set({ volume });
}

function beep(freq: number, seconds: number, gain = 1, when = 0): void {
  if (!ctx || !master || ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + when;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.setValueAtTime(gain, t0 + seconds - 0.02);
  g.gain.linearRampToValueAtTime(0, t0 + seconds);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + seconds + 0.05);
}

function stopLoop(): void {
  if (loop) window.clearInterval(loop);
  loop = null;
}

/**
 * Drive the sound from alarm state. Idempotent; call on every state change.
 * `refires` raises the volume of the critical siren in steps.
 */
export function setAlarmLevel(level: AlarmLevel, snoozed: boolean, refires = 0): void {
  const effective: AlarmLevel = snoozed ? 'none' : level;
  if (effective === state.level && (loop !== null || effective === 'none')) return;
  stopLoop();
  set({ level: effective, playing: false });
  if (!state.armed || effective === 'none') return;
  const boost = Math.min(1, 0.5 + refires * 0.25);
  if (effective === 'warning') {
    const chirp = () => {
      beep(660, 0.12, 0.35 * boost);
      beep(880, 0.12, 0.35 * boost, 0.16);
    };
    chirp();
    loop = window.setInterval(chirp, 4000);
  } else {
    const siren = () => {
      beep(800, 0.22, 0.9 * boost);
      beep(1000, 0.22, 0.9 * boost, 0.25);
    };
    siren();
    loop = window.setInterval(siren, 500);
  }
  set({ playing: true });
}

export function testTone(level: AlarmLevel): void {
  if (level === 'warning') {
    beep(660, 0.12, 0.35);
    beep(880, 0.12, 0.35, 0.16);
  } else if (level === 'critical') {
    beep(800, 0.22, 0.9);
    beep(1000, 0.22, 0.9, 0.25);
    beep(800, 0.22, 0.9, 0.5);
  }
}

export function useAudio(): AudioState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
