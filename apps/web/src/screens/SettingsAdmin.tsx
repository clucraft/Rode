import { useEffect, useState } from 'react';
import type { ZoneInput, ZoneRecord } from '@rode/protocol';
import { api, errorMessage } from '../api/client.js';
import { refreshAuth, useAuth } from '../api/auth.js';
import { useStore } from '../api/store.js';
import { fmtDateTime, fmtDuration, fmtLatLon } from '../lib/format.js';
import { ConfirmDialog, Dialog } from '../components/common.js';
import { PolarView } from '../components/PolarView.jsx';
import { useAuth as useAuthForUnits } from '../api/auth.js';
import { DEFAULT_UNITS } from '../lib/format.js';
import { StrengthMeter } from './Auth.jsx';
import { Panel } from './Settings.jsx';

/* Admin and account panels: zones, users, security, tokens, diagnostics. */

// ---------------------------------------------------------------- zones

export function Zones() {
  const [zones, setZones] = useState<ZoneRecord[]>([]);
  const [editing, setEditing] = useState<ZoneRecord | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .get<ZoneRecord[]>('/api/zones')
      .then(setZones)
      .catch((e: unknown) => setErr(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Panel title="Exclusion zones">
      <p className="muted small">
        Polygons the boat must never enter (a reef, a cable area, a lee shore) or must stay inside
        (a fairway). Checked independently of the swing circle: a radius alarm cannot know the coral
        sits inside the circle. Alarms on projected entry too, from current course and speed.
      </p>
      {err ? <p className="error">{err}</p> : null}
      <ul className="event-list" style={{ fontSize: '1rem' }}>
        {zones.map((z) => (
          <li key={z.id} style={{ gridTemplateColumns: '1fr auto' }}>
            <div>
              <strong>{z.name}</strong>{' '}
              <span className={`pill ${z.enabled ? 'ok' : ''}`}>{z.enabled ? 'on' : 'off'}</span>
              <div className="small muted">
                {z.kind === 'never-enter' ? 'never enter' : 'must stay inside'} · {z.polygon.length}{' '}
                points
              </div>
            </div>
            <button type="button" className="btn" onClick={() => setEditing(z)}>
              Edit
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn primary" onClick={() => setEditing('new')}>
        New zone
      </button>
      {editing ? (
        <ZoneEditor
          zone={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </Panel>
  );
}

function ZoneEditor(p: { zone: ZoneRecord | null; onClose: () => void; onSaved: () => void }) {
  const { state } = useStore();
  const [name, setName] = useState(p.zone?.name ?? '');
  const [kind, setKind] = useState<ZoneInput['kind']>(p.zone?.kind ?? 'never-enter');
  const [enabled, setEnabled] = useState(p.zone?.enabled ?? true);
  const [points, setPoints] = useState<{ lat: string; lon: string }[]>(
    p.zone
      ? p.zone.polygon.map((q) => ({ lat: String(q.lat), lon: String(q.lon) }))
      : [
          { lat: '', lon: '' },
          { lat: '', lon: '' },
          { lat: '', lon: '' },
        ],
  );
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draw, setDraw] = useState(false);
  const { settings } = useAuthForUnits();
  const here = state?.watch.live.boat ?? state?.instruments.position?.value ?? null;
  const drawn = points
    .map((q) => ({ lat: Number(q.lat), lon: Number(q.lon) }))
    .filter(
      (q) => Number.isFinite(q.lat) && Number.isFinite(q.lon) && (q.lat !== 0 || q.lon !== 0),
    );

  const save = async () => {
    setErr(null);
    const polygon = points.map((q) => ({ lat: Number(q.lat), lon: Number(q.lon) }));
    if (polygon.some((q) => !Number.isFinite(q.lat) || !Number.isFinite(q.lon))) {
      setErr('Every point needs a latitude and longitude in decimal degrees.');
      return;
    }
    const body: ZoneInput = { name, kind, enabled, polygon };
    try {
      if (p.zone) await api.put(`/api/zones/${p.zone.id}`, body);
      else await api.post('/api/zones', body);
      p.onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Dialog
      title={p.zone ? 'Edit zone' : 'New zone'}
      onClose={p.onClose}
      actions={
        <>
          {p.zone ? (
            <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          ) : null}
          <button type="button" className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()}>
            Save zone
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="z-name">Name</label>
        <input id="z-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="z-kind">Kind</label>
        <select
          id="z-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ZoneInput['kind'])}
        >
          <option value="never-enter">Never enter (reef, cable, shoal)</option>
          <option value="must-stay-inside">Must stay inside (fairway, channel)</option>
        </select>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{' '}
        Enabled
      </label>
      <p className="small muted">
        Draw on the view around the boat (tap to add points, in order around the shape), or type
        decimal degrees. "here" fills a row from the boat's position.
      </p>
      <div className="row">
        <button
          type="button"
          className={`btn ${draw ? 'primary' : ''}`}
          aria-pressed={draw}
          disabled={!here}
          onClick={() => setDraw((d) => !d)}
        >
          {draw ? 'Done drawing' : 'Draw on the view'}
        </button>
        {draw ? (
          <button
            type="button"
            className="btn quiet"
            onClick={() =>
              setPoints([
                { lat: '', lon: '' },
                { lat: '', lon: '' },
                { lat: '', lon: '' },
              ])
            }
          >
            Clear
          </button>
        ) : null}
      </div>
      {draw && here ? (
        <PolarView
          state="IDLE"
          anchor={state?.watch.session?.anchor ?? null}
          swingRadius={state?.watch.session?.geometry?.swingRadius ?? null}
          warnRadius={null}
          boat={here}
          headingRad={null}
          positionStale={false}
          track={[]}
          zones={[]}
          ais={[]}
          units={settings?.units ?? DEFAULT_UNITS}
          drawing={drawn}
          onTap={(pos) =>
            setPoints((ps) => {
              const next = { lat: pos.lat.toFixed(6), lon: pos.lon.toFixed(6) };
              const empty = ps.findIndex((q) => q.lat === '' && q.lon === '');
              return empty === -1 ? [...ps, next] : ps.map((q, i) => (i === empty ? next : q));
            })
          }
        />
      ) : null}
      {points.map((q, i) => (
        <div className="row" key={i}>
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Point ${i + 1} latitude`}
            placeholder="lat"
            value={q.lat}
            onChange={(e) =>
              setPoints((ps) => ps.map((r, j) => (j === i ? { ...r, lat: e.target.value } : r)))
            }
            style={{ flex: 1, minHeight: 40 }}
          />
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Point ${i + 1} longitude`}
            placeholder="lon"
            value={q.lon}
            onChange={(e) =>
              setPoints((ps) => ps.map((r, j) => (j === i ? { ...r, lon: e.target.value } : r)))
            }
            style={{ flex: 1, minHeight: 40 }}
          />
          <button
            type="button"
            className="btn quiet"
            disabled={!here}
            onClick={() =>
              here &&
              setPoints((ps) =>
                ps.map((r, j) =>
                  j === i ? { lat: here.lat.toFixed(6), lon: here.lon.toFixed(6) } : r,
                ),
              )
            }
          >
            here
          </button>
          <button
            type="button"
            className="btn quiet"
            aria-label="Remove point"
            disabled={points.length <= 3}
            onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn"
        onClick={() => setPoints((ps) => [...ps, { lat: '', lon: '' }])}
      >
        Add point
      </button>
      {err ? <p className="error">{err}</p> : null}
      {confirmDelete && p.zone ? (
        <ConfirmDialog
          title={`Delete ${p.zone.name}?`}
          danger
          body={<p>The zone stops being checked immediately.</p>}
          confirmLabel="Delete zone"
          onConfirm={async () => {
            await api.delete(`/api/zones/${p.zone?.id ?? ''}`);
            p.onSaved();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------- users

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'crew';
  totpEnabled: boolean;
  disabled: boolean;
}

export function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    username: '',
    displayName: '',
    password: '',
    role: 'crew' as 'admin' | 'crew',
  });
  const load = () =>
    api
      .get<UserRow[]>('/api/users')
      .then(setUsers)
      .catch((e: unknown) => setErr(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);
  const patch = async (id: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      await api.patch(`/api/users/${id}`, body);
      await load();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  return (
    <Panel title="Users">
      <p className="muted small">
        Admins change settings and users. Crew can view, acknowledge, and drop, set or weigh the
        anchor. A guest should be able to help without being able to reconfigure the boat.
      </p>
      {err ? <p className="error">{err}</p> : null}
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>2FA</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={u.disabled ? { opacity: 0.5 } : undefined}>
                <td>
                  {u.displayName} <span className="small muted">@{u.username}</span>
                </td>
                <td>
                  <select
                    value={u.role}
                    aria-label={`Role for ${u.username}`}
                    disabled={u.id === me?.id}
                    onChange={(e) => void patch(u.id, { role: e.target.value })}
                  >
                    <option value="admin">admin</option>
                    <option value="crew">crew</option>
                  </select>
                </td>
                <td>{u.totpEnabled ? 'on' : 'off'}</td>
                <td>
                  {u.id !== me?.id ? (
                    <button
                      type="button"
                      className="btn quiet"
                      onClick={() => void patch(u.id, { disabled: !u.disabled })}
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                  ) : (
                    <span className="small muted">you</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding ? (
        <Dialog
          title="New user"
          onClose={() => setAdding(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  setErr(null);
                  try {
                    await api.post('/api/users', form);
                    setAdding(false);
                    setForm({ username: '', displayName: '', password: '', role: 'crew' });
                    await load();
                  } catch (e) {
                    setErr(errorMessage(e));
                  }
                }}
              >
                Create
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="nu-user">Username</label>
            <input
              id="nu-user"
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="nu-name">Display name</label>
            <input
              id="nu-name"
              type="text"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="nu-pass">Password</label>
            <input
              id="nu-pass"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor="nu-role">Role</label>
            <select
              id="nu-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'crew' })}
            >
              <option value="crew">crew</option>
              <option value="admin">admin</option>
            </select>
          </div>
          {err ? <p className="error">{err}</p> : null}
        </Dialog>
      ) : null}
      <button type="button" className="btn primary" onClick={() => setAdding(true)}>
        Add user
      </button>
    </Panel>
  );
}

// ---------------------------------------------------------------- security (own account)

interface Device {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export function Security() {
  const { user, settings } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [strength, setStrength] = useState<Parameters<typeof StrengthMeter>[0]['s']>(null);
  const [totp, setTotp] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState('');

  const loadDevices = () =>
    api
      .get<Device[]>('/api/auth/devices')
      .then(setDevices)
      .catch(() => undefined);
  useEffect(() => {
    void loadDevices();
  }, []);
  useEffect(() => {
    if (!pw.next) {
      setStrength(null);
      return;
    }
    const h = window.setTimeout(() => {
      api
        .post<NonNullable<typeof strength>>('/api/auth/password-strength', {
          password: pw.next,
          inputs: [user?.username ?? ''],
        })
        .then(setStrength)
        .catch(() => setStrength(null));
    }, 250);
    return () => window.clearTimeout(h);
  }, [pw.next, user?.username]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Panel title="Your account">
      <p className="muted">
        Signed in as <strong>{user?.displayName}</strong> (@{user?.username}, {user?.role}).
      </p>
      {err ? <p className="error">{err}</p> : null}
      {msg ? <p className="muted">{msg}</p> : null}

      <section className="section">
        <h2>Password</h2>
        <div className="field">
          <label htmlFor="pw-cur">Current password</label>
          <input
            id="pw-cur"
            type="password"
            autoComplete="current-password"
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
          />
          <StrengthMeter s={strength} />
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={!pw.current || !pw.next}
          onClick={() =>
            void run(async () => {
              await api.post('/api/auth/password', {
                currentPassword: pw.current,
                newPassword: pw.next,
              });
              setPw({ current: '', next: '' });
              await loadDevices();
            }, 'Password changed. Other devices have been signed out.')
          }
        >
          Change password
        </button>
      </section>

      <section className="section">
        <h2>Two-factor authentication</h2>
        {user?.totpEnabled ? (
          <>
            <p className="small">
              On. You need a code from your authenticator app to sign in; recovery codes work once
              each.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void run(async () => {
                    const r = await api.post<{ recoveryCodes: string[] }>(
                      '/api/auth/totp/recovery-codes',
                    );
                    setRecovery(r.recoveryCodes);
                  }, 'New recovery codes generated. The old ones no longer work.')
                }
              >
                New recovery codes
              </button>
              <input
                type="password"
                placeholder="password to disable"
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
                style={{ minHeight: 44, padding: '0 .5rem' }}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="btn danger"
                disabled={!disablePw}
                onClick={() =>
                  void run(async () => {
                    await api.post('/api/auth/totp/disable', { password: disablePw });
                    setDisablePw('');
                    await refreshAuth();
                  }, 'Two-factor turned off.')
                }
              >
                Turn off
              </button>
            </div>
          </>
        ) : totp ? (
          <>
            <p className="small">
              Scan this in your authenticator app, or enter the secret by hand, then type the
              six-digit code it shows.
            </p>
            <p className="num" style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
              {totp.secret}
            </p>
            <p className="small muted" style={{ wordBreak: 'break-all' }}>
              {totp.url}
            </p>
            <div className="field">
              <label htmlFor="totp-code">Code</label>
              <input
                id="totp-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                void run(async () => {
                  const r = await api.post<{ recoveryCodes: string[] }>('/api/auth/totp/enable', {
                    code,
                  });
                  setRecovery(r.recoveryCodes);
                  setTotp(null);
                  setCode('');
                  await refreshAuth();
                }, 'Two-factor is on. Save the recovery codes somewhere safe; they are shown once.')
              }
            >
              Verify and turn on
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() =>
              void run(
                async () =>
                  setTotp(await api.post<{ secret: string; url: string }>('/api/auth/totp/setup')),
                '',
              )
            }
          >
            Set up two-factor
          </button>
        )}
        {recovery ? (
          <div className="notice">
            <strong>Recovery codes</strong> — each works once. Keep them off the boat.
            <pre className="num" style={{ fontFamily: 'var(--mono)' }}>
              {recovery.join('\n')}
            </pre>
            <button type="button" className="btn quiet" onClick={() => setRecovery(null)}>
              I have saved them
            </button>
          </div>
        ) : null}
      </section>

      <section className="section">
        <h2>Signed-in devices</h2>
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Address</th>
                <th>Last seen</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    {shortAgent(d.userAgent)}{' '}
                    {d.current ? <span className="pill ok">this device</span> : null}
                    <div className="small muted">
                      since {fmtDateTime(d.createdAt, settings?.timeZone)}
                    </div>
                  </td>
                  <td>{d.ip ?? '—'}</td>
                  <td>{fmtDuration(Date.now() - d.lastSeenAt)} ago</td>
                  <td>
                    {!d.current ? (
                      <button
                        type="button"
                        className="btn quiet"
                        onClick={() =>
                          void run(async () => {
                            await api.delete(`/api/auth/devices/${d.id}`);
                            await loadDevices();
                          }, 'Signed out that device.')
                        }
                      >
                        Sign out
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void run(async () => {
              await api.post('/api/auth/devices/revoke-others');
              await loadDevices();
            }, 'Signed out everywhere else.')
          }
        >
          Sign out other devices
        </button>
      </section>
    </Panel>
  );
}

function shortAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('Macintosh')) return 'Mac';
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Linux')) return 'Linux';
  return ua.slice(0, 30);
}

// ---------------------------------------------------------------- API tokens

export function Tokens() {
  const [tokens, setTokens] = useState<
    { id: string; name: string; createdAt: number; lastUsedAt: number | null }[]
  >([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .get<typeof tokens>('/api/tokens')
      .then(setTokens)
      .catch((e: unknown) => setErr(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Panel title="API tokens">
      <p className="muted small">
        Long-lived, read-only. Send as <code>Authorization: Bearer …</code> to{' '}
        <code>/api/state</code>, <code>/api/events</code>, <code>/api/sessions</code>. They cannot
        acknowledge, drop or change anything. A token is shown once, at creation.
      </p>
      {err ? <p className="error">{err}</p> : null}
      {created ? (
        <div className="notice">
          <strong>Copy this token now. It will not be shown again.</strong>
          <pre
            style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}
          >
            {created}
          </pre>
          <button type="button" className="btn quiet" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      ) : null}
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{fmtDateTime(t.createdAt)}</td>
              <td>{t.lastUsedAt ? `${fmtDuration(Date.now() - t.lastUsedAt)} ago` : 'never'}</td>
              <td>
                <button
                  type="button"
                  className="btn quiet"
                  onClick={() => void api.delete(`/api/tokens/${t.id}`).then(load)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input
          type="text"
          placeholder="name, e.g. home-assistant"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minHeight: 44, padding: '0 .5rem' }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!name}
          onClick={async () => {
            setErr(null);
            try {
              const r = await api.post<{ token: string }>('/api/tokens', { name });
              setCreated(r.token);
              setName('');
              await load();
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          Create token
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- diagnostics

interface Diag {
  stream: {
    sentencesPerSecond: number;
    byTypePerSecond: Record<string, number>;
    checksumErrorRate: number;
    malformedPerSecond: number;
    unsupportedTypes: Record<string, number>;
    totals: {
      lines: number;
      sentences: number;
      checksumFailures: number;
      unsupported: number;
      aisDecoded: number;
    };
    aisTargets: number;
    process: {
      cpuPercent: number;
      rssBytes: number;
      heapUsedBytes: number;
      uptimeS: number;
      loadAvg1: number;
      nodeVersion: string;
    };
  };
  source: {
    kind: string;
    state: { kind: string; since: number; reason?: string };
    stats: Record<string, number | string | null>;
    lastSentenceAt: number | null;
  };
  fieldAgeSeconds: Record<string, number | null>;
  samples: { count: number; oldestAt: number | null };
  time: {
    now: number;
    gpsSynced: boolean;
    gpsOffsetMs: number | null;
    lastGpsSyncAt: number | null;
  };
  health: {
    engineTicks: number;
    lastTickAt: number | null;
    unexpectedRestart: boolean;
    bootedAt: number;
    uptimeMs: number;
    dbSizeBytes: number;
    notificationsLastConfirmedAt: number | null;
  };
  engine: { phase: string; ticks: number; rehydrated: boolean };
  version: string;
}

export function Diagnostics() {
  const [d, setD] = useState<Diag | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { state } = useStore();
  useEffect(() => {
    const load = () =>
      api
        .get<Diag>('/api/diagnostics')
        .then(setD)
        .catch((e: unknown) => setErr(errorMessage(e)));
    void load();
    const h = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(h);
  }, []);
  if (err)
    return (
      <Panel title="Diagnostics">
        <p className="error">{err}</p>
      </Panel>
    );
  if (!d) return <Panel title="Diagnostics">Loading…</Panel>;
  const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
  return (
    <Panel title="Diagnostics">
      <section className="section">
        <h2>Source</h2>
        <div className="readouts num">
          <div className="readout">
            <span className="label">Adapter</span>
            <span className="value" style={{ fontSize: '1.1rem' }}>
              {d.source.kind}
            </span>
            <span className="sub">
              {d.source.state.kind}
              {d.source.state.reason ? ` · ${d.source.state.reason}` : ''} for{' '}
              {fmtDuration(d.time.now - d.source.state.since)}
            </span>
          </div>
          <div className="readout">
            <span className="label">Sentences / s</span>
            <span className="value">{d.stream.sentencesPerSecond}</span>
          </div>
          <div className="readout">
            <span className="label">Checksum error rate</span>
            <span className="value">
              {(d.stream.checksumErrorRate * 100).toFixed(2)}
              <span className="unit">%</span>
            </span>
          </div>
          <div className="readout">
            <span className="label">Reconnects</span>
            <span className="value">
              {String(d.source.stats.reconnects ?? d.source.stats.restarts ?? 0)}
            </span>
          </div>
          <div className="readout">
            <span className="label">Last sentence</span>
            <span className="value" style={{ fontSize: '1.1rem' }}>
              {d.source.lastSentenceAt
                ? `${fmtDuration(d.time.now - d.source.lastSentenceAt)} ago`
                : 'never'}
            </span>
          </div>
          <div className="readout">
            <span className="label">AIS targets</span>
            <span className="value">{d.stream.aisTargets}</span>
          </div>
        </div>
        <h3 style={{ marginTop: '0.75rem' }}>Rate by sentence type</h3>
        <p className="num small">
          {Object.entries(d.stream.byTypePerSecond)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} ${v}/s`)
            .join(' · ') || '—'}
        </p>
        {Object.keys(d.stream.unsupportedTypes).length > 0 ? (
          <p className="small muted">
            Ignored types:{' '}
            {Object.entries(d.stream.unsupportedTypes)
              .map(([k, v]) => `${k} (${v})`)
              .join(', ')}
          </p>
        ) : null}
      </section>

      <section className="section">
        <h2>Last sample age per field</h2>
        <p className="num small">
          {Object.entries(d.fieldAgeSeconds)
            .map(([k, v]) => `${k} ${v === null ? '—' : `${v}s`}`)
            .join(' · ') || 'no fields yet'}
        </p>
      </section>

      <section className="section">
        <h2>Engine and time</h2>
        <div className="readouts num">
          <div className="readout">
            <span className="label">Engine ticks</span>
            <span className="value">{d.engine.ticks}</span>
            <span className="sub">
              last{' '}
              {d.health.lastTickAt
                ? `${fmtDuration(d.time.now - d.health.lastTickAt)} ago`
                : 'never'}{' '}
              · {d.engine.phase}
              {d.engine.rehydrated ? ' · rehydrated at boot' : ''}
            </span>
          </div>
          <div className="readout">
            <span className="label">GPS time</span>
            <span className="value" style={{ fontSize: '1.1rem' }}>
              {d.time.gpsSynced ? 'synced' : 'not synced'}
            </span>
            <span className="sub">
              {d.time.gpsOffsetMs !== null
                ? `offset ${Math.round(d.time.gpsOffsetMs / 1000)} s from system clock`
                : 'no ZDA/RMC time seen'}
            </span>
          </div>
          <div className="readout">
            <span className="label">Uptime</span>
            <span className="value" style={{ fontSize: '1.1rem' }}>
              {fmtDuration(d.health.uptimeMs)}
            </span>
            <span className="sub">
              {d.health.unexpectedRestart ? 'last boot was not a clean shutdown' : 'clean boot'}
            </span>
          </div>
          <div className="readout">
            <span className="label">Notifications confirmed</span>
            <span className="value" style={{ fontSize: '1.1rem' }}>
              {d.health.notificationsLastConfirmedAt
                ? `${fmtDuration(d.time.now - d.health.notificationsLastConfirmedAt)} ago`
                : 'never'}
            </span>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Storage and process</h2>
        <div className="readouts num">
          <div className="readout">
            <span className="label">Database</span>
            <span className="value">{mb(d.health.dbSizeBytes)}</span>
            <span className="sub">
              {d.samples.count} samples
              {d.samples.oldestAt
                ? `, oldest ${fmtDuration(d.time.now - d.samples.oldestAt)} ago`
                : ''}
            </span>
          </div>
          <div className="readout">
            <span className="label">CPU</span>
            <span className="value">
              {d.stream.process.cpuPercent}
              <span className="unit">%</span>
            </span>
            <span className="sub">load {d.stream.process.loadAvg1}</span>
          </div>
          <div className="readout">
            <span className="label">Memory</span>
            <span className="value">{mb(d.stream.process.rssBytes)}</span>
            <span className="sub">heap {mb(d.stream.process.heapUsedBytes)}</span>
          </div>
          <div className="readout">
            <span className="label">Version</span>
            <span className="value" style={{ fontSize: '1.1rem' }}>
              {d.version}
            </span>
            <span className="sub">{d.stream.process.nodeVersion}</span>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Recent events</h2>
        <ul className="event-list num">
          {(state?.recentEvents ?? [])
            .slice(-30)
            .reverse()
            .map((e) => (
              <li key={e.seq}>
                <span className="t">{new Date(e.at).toLocaleTimeString()}</span>
                <span className={e.severity}>{e.type}</span>
              </li>
            ))}
        </ul>
      </section>
      <p className="small muted">Boat position: {fmtLatLon(state?.watch.live.boat ?? null)}</p>
      <section className="section">
        <h2>Backup</h2>
        <p className="small muted">
          A consistent snapshot of the whole database, taken while the watch keeps running. It
          contains the settings table, including notification tokens: keep it somewhere private.
        </p>
        <a className="btn" href="/api/admin/backup" download>
          Download backup
        </a>
      </section>
    </Panel>
  );
}
