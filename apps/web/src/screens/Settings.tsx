import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router';
import type { ConfigDoc } from '@rode/core';
import type { SettingsPatch, SettingsView } from '@rode/protocol';
import { api, errorMessage } from '../api/client.js';
import { logout, refreshSettings, useAuth } from '../api/auth.js';
import { store, useStore } from '../api/store.js';
import { setNightSchedule, setThemeMode, useTheme } from '../lib/theme.js';
import { testTone, useAudio } from '../lib/audio.js';
import {
  DEFAULT_UNITS,
  fromSiDistance,
  fromSiSpeed,
  toSiDistance,
  toSiSpeed,
} from '../lib/format.js';
import { ConfirmDialog } from '../components/common.js';

/*
 * Settings. Thresholds carry their explanation next to the control and a
 * "restore recommended defaults" button. Units convert at the edge. Admin
 * panels live in SettingsAdmin.tsx.
 */

export const DISCLAIMER = 'Rode does not replace a proper anchor watch or keeping a lookout.';

export function SettingsLayout() {
  return (
    <div className="stack">
      <Outlet />
    </div>
  );
}

export function SettingsIndex() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const items: { to: string; label: string; sub: string; admin?: boolean }[] = [
    {
      to: 'thresholds',
      label: 'Alarm thresholds',
      sub: 'Every number with the reason it is that number',
    },
    {
      to: 'boat',
      label: 'Boat geometry',
      sub: 'GPS antenna offset, bow roller height',
      admin: true,
    },
    { to: 'display', label: 'Units and display', sub: 'Units, night mode, low-bandwidth, sounds' },
    {
      to: 'source',
      label: 'Data source',
      sub: 'Cortex hub address, Signal K, simulator',
      admin: true,
    },
    {
      to: 'notifications',
      label: 'Notifications',
      sub: 'ntfy, Pushover, Telegram, webhook, email',
      admin: true,
    },
    { to: 'zones', label: 'Exclusion zones', sub: 'Reefs, cables, fairways', admin: true },
    { to: 'users', label: 'Users', sub: 'Admins and crew', admin: true },
    { to: 'security', label: 'Your account', sub: 'Password, two-factor, signed-in devices' },
    {
      to: 'tokens',
      label: 'API tokens',
      sub: 'Read-only access for Home Assistant, Grafana',
      admin: true,
    },
    {
      to: 'diagnostics',
      label: 'Diagnostics',
      sub: 'Sentence rates, source health, database, CPU',
    },
    { to: 'about', label: 'About', sub: 'Version, licence, the fine print' },
  ];
  return (
    <div className="stack">
      <h1>Settings</h1>
      <ul className="event-list" style={{ fontSize: '1rem' }}>
        {items
          .filter((i) => !i.admin || admin)
          .map((i) => (
            <li key={i.to} style={{ gridTemplateColumns: '1fr' }}>
              <Link
                to={i.to}
                style={{
                  textDecoration: 'none',
                  color: 'inherit',
                  display: 'block',
                  minHeight: 44,
                }}
              >
                <strong>{i.label}</strong>
                <div className="small muted">{i.sub}</div>
              </Link>
            </li>
          ))}
      </ul>
      <p className="small muted">{DISCLAIMER}</p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void logout()}>
          Sign out {user ? `(${user.username})` : ''}
        </button>
      </div>
    </div>
  );
}

export function Panel(p: { title: string; back?: string; children: ReactNode }) {
  return (
    <div className="stack">
      <p>
        <Link to={p.back ?? '/settings'}>← Settings</Link>
      </p>
      <h1>{p.title}</h1>
      {p.children}
    </div>
  );
}

// ---------------------------------------------------------------- thresholds

interface Docs {
  alarm: Record<string, ConfigDoc>;
  alarmDefaults: Record<string, number>;
}

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Swing circle', keys: ['swingMargin', 'hdopUere', 'hdopMarginCap'] },
  {
    title: 'Early warnings',
    keys: [
      'warnDistance',
      'positionHoldMs',
      'outsideHoldMs',
      'awaWindow',
      'awaHoldMs',
      'awaMinWindSpeed',
      'sogThreshold',
      'sogHoldMs',
      'clearHoldMs',
    ],
  },
  { title: 'Data liveness', keys: ['gpsStaleWarnMs', 'gpsStaleCriticalMs', 'sourceGraceMs'] },
  { title: 'Depth', keys: ['minDepth', 'depthHoldMs'] },
  { title: 'Exclusion zones', keys: ['zoneLookaheadMs', 'zoneHoldMs'] },
  { title: 'Marina', keys: ['marinaRadius', 'marinaSogThreshold'] },
  { title: 'Acknowledgement', keys: ['snoozeMs'] },
];

export function Thresholds() {
  const { settings, user } = useAuth();
  const [docs, setDocs] = useState<Docs | null>(null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const units = settings?.units ?? DEFAULT_UNITS;
  const admin = user?.role === 'admin';

  useEffect(() => {
    api
      .get<Docs>('/api/settings/docs')
      .then(setDocs)
      .catch((e: unknown) => setErr(errorMessage(e)));
  }, []);
  useEffect(() => {
    if (settings) setDraft({ ...settings.alarm });
  }, [settings]);

  if (!docs || !settings) return <Panel title="Alarm thresholds">Loading…</Panel>;

  // Display conversion per unit kind.
  const toDisplay = (key: string, si: number): { value: number; unit: string; step: number } => {
    const doc = docs.alarm[key];
    switch (doc?.unit) {
      case 'm':
        return { value: round(fromSiDistance(si, units), 1), unit: units.distance, step: 0.5 };
      case 'm/s':
        return { value: round(fromSiSpeed(si, units), 2), unit: units.speed, step: 0.1 };
      case 'rad':
        return { value: round((si * 180) / Math.PI, 0), unit: '°', step: 1 };
      case 'ms':
        return { value: round(si / 1000, 0), unit: 's', step: 1 };
      default:
        return { value: si, unit: '', step: 0.1 };
    }
  };
  const toSi = (key: string, display: number): number => {
    const doc = docs.alarm[key];
    switch (doc?.unit) {
      case 'm':
        return toSiDistance(display, units);
      case 'm/s':
        return toSiSpeed(display, units);
      case 'rad':
        return (display * Math.PI) / 180;
      case 'ms':
        return display * 1000;
      default:
        return display;
    }
  };

  const save = async () => {
    setErr(null);
    setSaved(false);
    try {
      await api.patch('/api/settings', { alarm: draft } satisfies SettingsPatch);
      await refreshSettings();
      setSaved(true);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Panel title="Alarm thresholds">
      <p className="muted">
        Each value shows the recommended default and why it is what it is. Change them if your boat
        and anchorage say so; the defaults came from real nights at anchor.
      </p>
      {GROUPS.map((g) => (
        <section key={g.title} className="section">
          <h2>{g.title}</h2>
          {g.keys.map((key) => {
            const doc = docs.alarm[key];
            if (!doc) return null;
            const cur = draft[key] ?? docs.alarmDefaults[key] ?? 0;
            const d = toDisplay(key, cur);
            const def = toDisplay(key, docs.alarmDefaults[key] ?? 0);
            return (
              <div className="field" key={key}>
                <label htmlFor={`th-${key}`}>{doc.label}</label>
                <div className="unit">
                  <input
                    id={`th-${key}`}
                    type="number"
                    inputMode="decimal"
                    step={d.step}
                    value={d.value}
                    disabled={!admin}
                    onChange={(e) =>
                      setDraft((x) => ({ ...x, [key]: toSi(key, Number(e.target.value)) }))
                    }
                  />
                  <span>{d.unit}</span>
                </div>
                <span className="why">
                  Default {def.value} {def.unit}. {doc.why}
                </span>
              </div>
            );
          })}
        </section>
      ))}
      {err ? <p className="error">{err}</p> : null}
      {saved ? (
        <p className="muted">Saved. The engine uses the new values from the next tick.</p>
      ) : null}
      {admin ? (
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => void save()}>
            Save thresholds
          </button>
          <button type="button" className="btn" onClick={() => setConfirmRestore(true)}>
            Restore recommended defaults
          </button>
        </div>
      ) : (
        <p className="muted small">Only an admin can change thresholds.</p>
      )}
      {confirmRestore ? (
        <ConfirmDialog
          title="Restore recommended defaults?"
          body={<p>Every alarm and marina threshold goes back to the field-tested values.</p>}
          confirmLabel="Restore"
          onConfirm={async () => {
            await api.post('/api/settings/alarm/restore-defaults');
            await refreshSettings();
          }}
          onClose={() => setConfirmRestore(false)}
        />
      ) : null}
    </Panel>
  );
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------- boat geometry

export function BoatGeometry() {
  const { settings } = useAuth();
  const units = settings?.units ?? DEFAULT_UNITS;
  const [draft, setDraft] = useState<SettingsView['boat'] | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings) {
      setDraft({ ...settings.boat });
      setName(settings.boatName);
      setScope(settings.suggestedScope);
    }
  }, [settings]);
  if (!draft) return <Panel title="Boat geometry">Loading…</Panel>;
  const u = units.distance;
  const show = (m: number) => round(fromSiDistance(m, units), 2);
  const set = (k: keyof SettingsView['boat'], v: number) =>
    setDraft((d) => (d ? { ...d, [k]: toSiDistance(v, units) } : d));
  return (
    <Panel title="Boat geometry">
      <p className="muted">
        The GNSS antenna is rarely at the bow roller. On a 12 m boat it is often 8–10 m aft of it,
        which puts several metres of false radius into every swing circle unless it is measured.
        Stand at the antenna, measure to the bow roller along the centreline, then athwartships.
      </p>
      <div className="field">
        <label htmlFor="bg-name">Boat name</label>
        <input id="bg-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="bg-fwd">Antenna to bow roller, forward ({u})</label>
        <input
          id="bg-fwd"
          type="number"
          inputMode="decimal"
          step="0.1"
          value={show(draft.antennaToBowForward)}
          onChange={(e) => set('antennaToBowForward', Number(e.target.value))}
        />
        <span className="why">
          Positive when the roller is forward of the antenna. Nearly always positive.
        </span>
      </div>
      <div className="field">
        <label htmlFor="bg-stbd">Antenna to bow roller, to starboard ({u})</label>
        <input
          id="bg-stbd"
          type="number"
          inputMode="decimal"
          step="0.1"
          value={show(draft.antennaToBowStarboard)}
          onChange={(e) => set('antennaToBowStarboard', Number(e.target.value))}
        />
        <span className="why">
          Negative if the roller is to port of the antenna. Usually close to zero.
        </span>
      </div>
      <div className="field">
        <label htmlFor="bg-h">Bow roller height above the waterline ({u})</label>
        <input
          id="bg-h"
          type="number"
          inputMode="decimal"
          step="0.1"
          value={show(draft.bowRollerHeight)}
          onChange={(e) => set('bowRollerHeight', Number(e.target.value))}
        />
        <span className="why">
          Added to the depth for the rode triangle. The scope you actually have is measured from the
          roller, not the surface.
        </span>
      </div>
      <div className="field">
        <label htmlFor="bg-scope">Target scope for the rode suggestion</label>
        <div className="unit">
          <input
            id="bg-scope"
            type="number"
            inputMode="decimal"
            step="0.5"
            min="2"
            max="10"
            value={scope}
            onChange={(e) => setScope(Number(e.target.value))}
          />
          <span>:1</span>
        </div>
        <span className="why">
          Shown before the hook goes down, from the current depth. 5:1 for chain in settled weather;
          7:1 if it is going to blow.
        </span>
      </div>
      {err ? <p className="error">{err}</p> : null}
      {saved ? <p className="muted">Saved.</p> : null}
      <button
        type="button"
        className="btn primary"
        onClick={async () => {
          setErr(null);
          try {
            await api.patch('/api/settings', {
              boat: draft,
              boatName: name,
              suggestedScope: scope,
            } satisfies SettingsPatch);
            await refreshSettings();
            setSaved(true);
          } catch (e) {
            setErr(errorMessage(e));
          }
        }}
      >
        Save
      </button>
    </Panel>
  );
}

// ---------------------------------------------------------------- units & display

export function Display() {
  const { settings, user } = useAuth();
  const theme = useTheme();
  const audio = useAudio();
  const { lowBandwidth } = useStore();
  const [draft, setDraft] = useState<SettingsView['units'] | null>(null);
  const [night, setNight] = useState<SettingsView['nightMode'] | null>(null);
  const [tz, setTz] = useState('UTC');
  const [err, setErr] = useState<string | null>(null);
  const admin = user?.role === 'admin';
  useEffect(() => {
    if (settings) {
      setDraft({ ...settings.units });
      setNight({ ...settings.nightMode });
      setTz(settings.timeZone);
    }
  }, [settings]);
  if (!draft || !night) return <Panel title="Units and display">Loading…</Panel>;
  const sel = (k: keyof SettingsView['units'], opts: string[]) => (
    <div className="field" key={k}>
      <label htmlFor={`u-${k}`}>{k}</label>
      <select
        id={`u-${k}`}
        value={draft[k]}
        disabled={!admin}
        onChange={(e) => setDraft((d) => (d ? { ...d, [k]: e.target.value } : d))}
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <Panel title="Units and display">
      <section className="section">
        <h2>Units</h2>
        <p className="muted small">
          Units are per boat. Everything is stored in metres and metres per second; these only
          change what you see.
        </p>
        {sel('distance', ['m', 'ft'])}
        {sel('rode', ['m', 'ft'])}
        {sel('depth', ['m', 'ft', 'fathoms'])}
        {sel('speed', ['kn', 'm/s', 'km/h', 'mph'])}
        {sel('temperature', ['C', 'F'])}
        <div className="field">
          <label htmlFor="u-tz">Time zone (IANA)</label>
          <input
            id="u-tz"
            type="text"
            value={tz}
            disabled={!admin}
            onChange={(e) => setTz(e.target.value)}
            placeholder="e.g. Atlantic/Bermuda"
          />
          <span className="why">Used for the daily heartbeat time and the solar window.</span>
        </div>
      </section>

      <section className="section">
        <h2>Night mode</h2>
        <p className="muted small">
          A red-shifted palette that keeps your night vision. The schedule is per boat; the switch
          below is this device only and wins until the next scheduled change.
        </p>
        <div className="btn-row">
          {(['auto', 'day', 'night'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`btn ${theme.mode === m ? 'primary' : ''}`}
              aria-pressed={theme.mode === m}
              onClick={() => setThemeMode(m)}
            >
              {m === 'auto' ? 'Follow schedule' : m === 'day' ? 'Day' : 'Night'}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <div className="field">
            <label htmlFor="n-mode">Schedule</label>
            <select
              id="n-mode"
              value={night.mode}
              disabled={!admin}
              onChange={(e) =>
                setNight((n) => (n ? { ...n, mode: e.target.value as 'auto' | 'on' | 'off' } : n))
              }
            >
              <option value="auto">On between the hours below</option>
              <option value="on">Always night</option>
              <option value="off">Never automatic</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="n-from">From</label>
            <input
              id="n-from"
              type="time"
              value={night.from}
              disabled={!admin}
              onChange={(e) => setNight((n) => (n ? { ...n, from: e.target.value } : n))}
            />
          </div>
          <div className="field">
            <label htmlFor="n-to">To</label>
            <input
              id="n-to"
              type="time"
              value={night.to}
              disabled={!admin}
              onChange={(e) => setNight((n) => (n ? { ...n, to: e.target.value } : n))}
            />
          </div>
        </div>
      </section>

      <section className="section">
        <h2>This device</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={lowBandwidth}
            onChange={(e) => store.setLowBandwidth(e.target.checked)}
          />
          Low-bandwidth mode: updates every 5 s, AIS and instruments only when the watch state
          changes
        </label>
        <p className="small muted">
          For a bad cell link from the dinghy. The alarm engine on the boat is unaffected.
        </p>
        <div className="row">
          <span>Alarm sound: {audio.armed ? 'armed' : 'off'}</span>
          <button
            type="button"
            className="btn"
            disabled={!audio.armed}
            onClick={() => testTone('warning')}
          >
            Test warning
          </button>
          <button
            type="button"
            className="btn"
            disabled={!audio.armed}
            onClick={() => testTone('critical')}
          >
            Test alarm
          </button>
        </div>
      </section>

      {err ? <p className="error">{err}</p> : null}
      {admin ? (
        <button
          type="button"
          className="btn primary"
          onClick={async () => {
            setErr(null);
            try {
              await api.patch('/api/settings', {
                units: draft,
                nightMode: night,
                timeZone: tz,
              } satisfies SettingsPatch);
              await refreshSettings();
              setNightSchedule(night);
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          Save
        </button>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------- source

export function Source() {
  const { settings } = useAuth();
  const [draft, setDraft] = useState<SettingsView['source'] | null>(null);
  const [scenarios, setScenarios] = useState<{ id: string; name: string; description: string }[]>(
    [],
  );
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (settings) setDraft({ ...settings.source });
  }, [settings]);
  useEffect(() => {
    api
      .get<{ scenarios: { id: string; name: string; description: string }[] }>('/api/settings/docs')
      .then((d) => setScenarios(d.scenarios))
      .catch(() => undefined);
  }, []);
  if (!draft) return <Panel title="Data source">Loading…</Panel>;
  const set = <K extends keyof SettingsView['source']>(k: K, v: SettingsView['source'][K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  return (
    <Panel title="Data source">
      <div className="field">
        <label htmlFor="src-kind">Source</label>
        <select
          id="src-kind"
          value={draft.kind}
          onChange={(e) => set('kind', e.target.value as SettingsView['source']['kind'])}
        >
          <option value="nmea0183-tcp">NMEA 0183 over TCP (Cortex hub)</option>
          <option value="nmea0183-udp">NMEA 0183 over UDP</option>
          <option value="signalk-ws">Signal K server</option>
          <option value="simulator">Simulator</option>
          <option value="replay">Replay a recording</option>
        </select>
      </div>
      {draft.kind === 'nmea0183-tcp' || draft.kind === 'nmea0183-udp' ? (
        <>
          {draft.kind === 'nmea0183-tcp' ? (
            <div className="field">
              <label htmlFor="src-host">Hub address</label>
              <input
                id="src-host"
                type="text"
                value={draft.host}
                onChange={(e) => set('host', e.target.value)}
              />
              <span className="why">
                Find it in the Cortex Onboard app under the hub's network settings.
              </span>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="src-port">Port</label>
            <input
              id="src-port"
              type="number"
              value={draft.port}
              onChange={(e) => set('port', Number(e.target.value))}
            />
            <span className="why">
              Vesper transponders have historically served NMEA 0183 on 39150. Verify on your unit.
            </span>
          </div>
        </>
      ) : null}
      {draft.kind === 'signalk-ws' ? (
        <>
          <div className="field">
            <label htmlFor="src-sk">Signal K stream URL</label>
            <input
              id="src-sk"
              type="url"
              value={draft.signalkUrl}
              placeholder="ws://signalk.local:3000/signalk/v1/stream"
              onChange={(e) => set('signalkUrl', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="src-skt">Access token (optional)</label>
            <input
              id="src-skt"
              type="password"
              value={draft.signalkToken}
              onChange={(e) => set('signalkToken', e.target.value)}
              autoComplete="off"
            />
          </div>
        </>
      ) : null}
      {draft.kind === 'simulator' ? (
        <>
          <div className="field">
            <label htmlFor="src-scn">Scenario</label>
            <select
              id="src-scn"
              value={draft.simScenario}
              onChange={(e) => set('simScenario', e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="why">
              {scenarios.find((s) => s.id === draft.simScenario)?.description}
            </span>
          </div>
          <div className="field">
            <label htmlFor="src-spd">Speed-up</label>
            <input
              id="src-spd"
              type="number"
              min="0.1"
              max="3600"
              value={draft.simSpeed}
              onChange={(e) => set('simSpeed', Number(e.target.value))}
            />
          </div>
        </>
      ) : null}
      {draft.kind === 'replay' ? (
        <>
          <div className="field">
            <label htmlFor="src-file">Recording file (relative to the data directory)</label>
            <input
              id="src-file"
              type="text"
              value={draft.replayFile}
              placeholder="recordings/2026-09-01.nmea"
              onChange={(e) => set('replayFile', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="src-rspd">Speed-up</label>
            <input
              id="src-rspd"
              type="number"
              min="0.1"
              max="3600"
              value={draft.simSpeed}
              onChange={(e) => set('simSpeed', Number(e.target.value))}
            />
          </div>
        </>
      ) : null}
      <div className="field">
        <label htmlFor="src-td">Transducer depth below the waterline (m)</label>
        <input
          id="src-td"
          type="number"
          step="0.05"
          value={draft.transducerDepth}
          onChange={(e) => set('transducerDepth', Number(e.target.value))}
        />
        <span className="why">
          Added to DBT depths and to DPT depths that carry no offset, so the sounder reads from the
          surface.
        </span>
      </div>
      <div className="field">
        <label htmlFor="src-var">
          Magnetic variation, degrees east (blank = from the receiver)
        </label>
        <input
          id="src-var"
          type="number"
          step="0.1"
          value={draft.magneticVariationDeg ?? ''}
          onChange={(e) =>
            set('magneticVariationDeg', e.target.value === '' ? null : Number(e.target.value))
          }
        />
        <span className="why">
          Only needed if the compass sends magnetic headings and the GPS sends no variation.
        </span>
      </div>
      {err ? <p className="error">{err}</p> : null}
      {msg ? <p className="muted">{msg}</p> : null}
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          onClick={async () => {
            setErr(null);
            setMsg(null);
            try {
              await api.patch('/api/settings', { source: draft } satisfies SettingsPatch);
              await refreshSettings();
              setMsg('Saved. The source reconnects with the new settings.');
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          Save and reconnect
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              await api.post('/api/source/restart');
              setMsg('Reconnecting…');
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          Reconnect now
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- about

export function About() {
  const { state } = useStore();
  return (
    <Panel title="About">
      <p>
        <strong>Rode</strong> — a self-hosted anchor watch and boat monitor. Server{' '}
        {state?.health ? `up ${Math.round(state.health.uptimeMs / 60_000)} min` : ''}.
      </p>
      <p className="notice">{DISCLAIMER}</p>
      <p className="small muted">
        The alarm engine runs on the boat, not in this browser. If this page is closed, the watch
        continues and notifications still go out. Position, depth and wind come from the Cortex hub
        via NMEA; the rode and scope shown are computed from where the anchor went down and where
        the boat lay after backing down, not assumed.
      </p>
      <p className="small muted">
        The threshold defaults come from the lessons published by a cruising couple who built a
        similar system on Home Assistant and Signal K. Every silent failure they found has a
        liveness check here.
      </p>
    </Panel>
  );
}
