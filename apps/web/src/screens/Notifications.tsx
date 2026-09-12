import { useEffect, useState } from 'react';
import type {
  ChannelTarget,
  DeliveryRecord,
  NotificationSettings,
  NotificationStats,
  Recipient,
} from '@rode/protocol';
import { api, errorMessage } from '../api/client.js';
import { fmtDuration, fmtTime } from '../lib/format.js';
import { Panel } from './Settings.jsx';

/*
 * Recipients, each with channels routed by severity; a test button that
 * reports per-target results; the heartbeat schedule; delivery stats and the
 * recent delivery log. Secrets come back masked and stay masked unless
 * retyped.
 */

type Kind = ChannelTarget['kind'];
const KINDS: { kind: Kind; label: string; help: string }[] = [
  {
    kind: 'ntfy',
    label: 'ntfy',
    help: 'Self-hostable push with iOS critical alerts. Paste the full topic URL.',
  },
  {
    kind: 'pushover',
    label: 'Pushover',
    help: 'Critical alarms use emergency priority: they repeat until acknowledged.',
  },
  { kind: 'telegram', label: 'Telegram', help: 'A bot token from @BotFather and your chat id.' },
  { kind: 'webhook', label: 'Webhook', help: 'POSTs JSON. Point Home Assistant or a relay at it.' },
  {
    kind: 'mqtt',
    label: 'MQTT',
    help: 'Publishes to <prefix>/notify/<severity>. Use the mqtt compose profile or your own broker.',
  },
  { kind: 'email', label: 'Email', help: 'For the daily heartbeat. Needs SMTP below.' },
];
const SEVERITIES = ['info', 'warning', 'critical'] as const;

function blank(kind: Kind): ChannelTarget {
  switch (kind) {
    case 'ntfy':
      return {
        kind,
        enabled: true,
        severities: ['info', 'warning', 'critical'],
        url: '',
        token: '',
      };
    case 'pushover':
      return { kind, enabled: true, severities: ['warning', 'critical'], token: '', user: '' };
    case 'telegram':
      return { kind, enabled: true, severities: ['warning', 'critical'], botToken: '', chatId: '' };
    case 'webhook':
      return {
        kind,
        enabled: true,
        severities: ['info', 'warning', 'critical'],
        url: '',
        headers: {},
      };
    case 'mqtt':
      return {
        kind,
        enabled: true,
        severities: ['info', 'warning', 'critical'],
        url: 'mqtt://mosquitto:1883',
        username: '',
        password: '',
        topicPrefix: 'rode',
      };
    case 'email':
      return { kind, enabled: true, severities: ['info'], to: '' };
  }
}

export function Notifications() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [stats, setStats] = useState<NotificationStats | null>(null);
  const [envRecipient, setEnvRecipient] = useState<{ name: string; channels: string[] } | null>(
    null,
  );
  const [deliveries, setDeliveries] = useState<DeliveryRecord[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<DeliveryRecord[] | null>(null);

  const load = async () => {
    const r = await api.get<{
      settings: NotificationSettings;
      stats: NotificationStats;
      envRecipient: { name: string; channels: string[] } | null;
    }>('/api/notifications');
    setSettings(r.settings);
    setStats(r.stats);
    setEnvRecipient(r.envRecipient);
    setDeliveries(await api.get<DeliveryRecord[]>('/api/notifications/deliveries'));
  };
  useEffect(() => {
    load().catch((e: unknown) => setErr(errorMessage(e)));
  }, []);

  if (!settings)
    return <Panel title="Notifications">{err ? <p className="error">{err}</p> : 'Loading…'}</Panel>;

  const update = (fn: (s: NotificationSettings) => NotificationSettings) =>
    setSettings((s) => (s ? fn(s) : s));
  const save = async () => {
    setErr(null);
    setMsg(null);
    try {
      setSettings(await api.put<NotificationSettings>('/api/notifications', settings));
      setMsg('Saved.');
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const test = async (recipientId?: string) => {
    setTesting(recipientId ?? 'all');
    setTestResults(null);
    try {
      const r = await api.post<{ results: DeliveryRecord[] }>(
        '/api/notifications/test',
        recipientId ? { recipientId } : {},
      );
      setTestResults(r.results);
      await load();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setTesting(null);
    }
  };

  return (
    <Panel title="Notifications">
      <div className="notice">
        <strong>Last confirmed working:</strong>{' '}
        {stats?.lastConfirmedAt
          ? `${fmtDuration(Date.now() - stats.lastConfirmedAt)} ago`
          : 'never'}
        {stats
          ? ` · last 24 h: ${stats.sent24h} delivered, ${stats.failed24h} failed${stats.queued > 0 ? `, ${stats.queued} queued` : ''}`
          : ''}
        <p className="small muted" style={{ marginTop: '0.4rem', marginBottom: 0 }}>
          Every anchor set and every weigh sends a confirmation. It reads as a convenience; its real
          job is proving this path is alive at the moment you are paying attention. If the "anchor
          watch active" message does not arrive, fix that before you go to sleep.
        </p>
      </div>
      {err ? <p className="error">{err}</p> : null}
      {msg ? <p className="muted">{msg}</p> : null}

      <section className="section">
        <h2>Recipients</h2>
        {envRecipient ? (
          <p className="small muted">
            Plus <strong>{envRecipient.name}</strong> from the container environment (
            {envRecipient.channels.join(', ')}). Edit it in <code>.env</code>.
          </p>
        ) : null}
        {settings.recipients.map((r, ri) => (
          <RecipientEditor
            key={r.id}
            recipient={r}
            onChange={(next) =>
              update((s) => ({
                ...s,
                recipients: s.recipients.map((x, i) => (i === ri ? next : x)),
              }))
            }
            onRemove={() =>
              update((s) => ({ ...s, recipients: s.recipients.filter((_, i) => i !== ri) }))
            }
            onTest={() => void test(r.id)}
            testing={testing === r.id}
            stats={stats}
          />
        ))}
        <button
          type="button"
          className="btn"
          onClick={() =>
            update((s) => ({
              ...s,
              recipients: [
                ...s.recipients,
                {
                  id: `r-${Date.now().toString(36)}`,
                  name: `Recipient ${s.recipients.length + 1}`,
                  enabled: true,
                  channels: [],
                },
              ],
            }))
          }
        >
          Add recipient
        </button>
      </section>

      <section className="section">
        <h2>Daily heartbeat</h2>
        <p className="small muted">
          A status message every morning: position, battery, solar, fridge and freezer, GPS health,
          uptime. Three weeks of silence is ambiguous when you are a thousand miles away; a daily
          message turns silence into a signal.
        </p>
        <div className="row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.heartbeat.enabled}
              onChange={(e) =>
                update((s) => ({ ...s, heartbeat: { ...s.heartbeat, enabled: e.target.checked } }))
              }
            />{' '}
            Enabled
          </label>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="hb-time">Local time</label>
            <input
              id="hb-time"
              type="time"
              value={settings.heartbeat.localTime}
              onChange={(e) =>
                update((s) => ({ ...s, heartbeat: { ...s.heartbeat, localTime: e.target.value } }))
              }
            />
          </div>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void api
                .post('/api/notifications/heartbeat')
                .then(() => setMsg('Heartbeat sent.'))
                .catch((e: unknown) => setErr(errorMessage(e)))
            }
          >
            Send one now
          </button>
        </div>
      </section>

      <section className="section">
        <h2>SMTP (email)</h2>
        <div className="row">
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="smtp-host">Host</label>
            <input
              id="smtp-host"
              type="text"
              value={settings.smtp.host}
              onChange={(e) => update((s) => ({ ...s, smtp: { ...s.smtp, host: e.target.value } }))}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="smtp-port">Port</label>
            <input
              id="smtp-port"
              type="number"
              value={settings.smtp.port}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  smtp: {
                    ...s.smtp,
                    port: Number(e.target.value),
                    secure: Number(e.target.value) === 465,
                  },
                }))
              }
            />
          </div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="smtp-user">User</label>
            <input
              id="smtp-user"
              type="text"
              value={settings.smtp.user}
              onChange={(e) => update((s) => ({ ...s, smtp: { ...s.smtp, user: e.target.value } }))}
              autoComplete="off"
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="smtp-pass">Password</label>
            <input
              id="smtp-pass"
              type="password"
              value={settings.smtp.pass}
              onChange={(e) => update((s) => ({ ...s, smtp: { ...s.smtp, pass: e.target.value } }))}
              autoComplete="new-password"
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="smtp-from">From</label>
            <input
              id="smtp-from"
              type="text"
              value={settings.smtp.from}
              onChange={(e) => update((s) => ({ ...s, smtp: { ...s.smtp, from: e.target.value } }))}
            />
          </div>
        </div>
      </section>

      <div className="btn-row">
        <button type="button" className="btn primary" onClick={() => void save()}>
          Save notifications
        </button>
        <button
          type="button"
          className="btn"
          disabled={testing !== null}
          onClick={() => void test()}
        >
          {testing === 'all' ? 'Testing…' : 'Send a test to everyone'}
        </button>
      </div>
      <p className="small muted">Save before testing: the test uses what is stored on the boat.</p>

      {testResults ? (
        <ul className="event-list">
          {testResults.map((r, i) => (
            <li key={i} style={{ gridTemplateColumns: '1fr' }}>
              <span className={r.ok ? '' : 'critical'}>
                {r.recipientName} · {r.channel}:{' '}
                {r.ok
                  ? `delivered in ${r.durationMs} ms`
                  : `failed: ${r.error ?? r.status ?? 'unknown'}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <section className="section">
        <h2>Recent deliveries</h2>
        {deliveries.length === 0 ? (
          <p className="muted small">Nothing sent yet.</p>
        ) : (
          <ul className="event-list num">
            {deliveries
              .slice()
              .reverse()
              .map((d, i) => (
                <li key={i}>
                  <span className="t">{fmtTime(d.at)}</span>
                  <span className={d.ok ? '' : 'warning'}>
                    {d.recipientName} · {d.channel} · {d.title} ·{' '}
                    {d.ok
                      ? `ok ${d.durationMs} ms`
                      : `failed (attempt ${d.attempt}): ${d.error ?? d.status ?? '?'}`}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </Panel>
  );
}

function RecipientEditor(p: {
  recipient: Recipient;
  onChange: (r: Recipient) => void;
  onRemove: () => void;
  onTest: () => void;
  testing: boolean;
  stats: NotificationStats | null;
}) {
  const r = p.recipient;
  const [addKind, setAddKind] = useState<Kind>('ntfy');
  return (
    <div
      className="notice"
      style={{ borderLeftColor: r.enabled ? 'var(--accent)' : 'var(--line)' }}
    >
      <div className="row">
        <input
          type="text"
          value={r.name}
          aria-label="Recipient name"
          onChange={(e) => p.onChange({ ...r, name: e.target.value })}
          style={{ flex: 1, minHeight: 40, padding: '0 .5rem', fontWeight: 600 }}
        />
        <label className="checkbox" style={{ minHeight: 0 }}>
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => p.onChange({ ...r, enabled: e.target.checked })}
          />{' '}
          on
        </label>
        <button
          type="button"
          className="btn quiet"
          onClick={p.onTest}
          disabled={p.testing || r.channels.length === 0}
        >
          {p.testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          className="btn quiet"
          onClick={p.onRemove}
          aria-label={`Remove ${r.name}`}
        >
          Remove
        </button>
      </div>
      {r.channels.map((c, ci) => (
        <ChannelEditor
          key={ci}
          channel={c}
          status={p.stats?.targets[`${r.id}:${c.kind}`] ?? null}
          onChange={(next) =>
            p.onChange({ ...r, channels: r.channels.map((x, i) => (i === ci ? next : x)) })
          }
          onRemove={() => p.onChange({ ...r, channels: r.channels.filter((_, i) => i !== ci) })}
        />
      ))}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <select
          value={addKind}
          aria-label="Channel type"
          onChange={(e) => setAddKind(e.target.value as Kind)}
          style={{ minHeight: 40 }}
        >
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={() => p.onChange({ ...r, channels: [...r.channels, blank(addKind)] })}
        >
          Add channel
        </button>
      </div>
    </div>
  );
}

function ChannelEditor(p: {
  channel: ChannelTarget;
  status: NotificationStats['targets'][string] | null;
  onChange: (c: ChannelTarget) => void;
  onRemove: () => void;
}) {
  const c = p.channel;
  const info = KINDS.find((k) => k.kind === c.kind);
  const field = (label: string, key: string, type: 'text' | 'password' | 'url' = 'text') => (
    <div className="field" style={{ marginBottom: '0.5rem' }}>
      <label>{label}</label>
      <input
        type={type}
        value={stringField(c, key)}
        onChange={(e) => p.onChange({ ...c, [key]: e.target.value })}
        autoComplete="off"
      />
    </div>
  );
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
      <div className="row">
        <strong>{info?.label ?? c.kind}</strong>
        <label className="checkbox small" style={{ minHeight: 0 }}>
          <input
            type="checkbox"
            checked={c.enabled}
            onChange={(e) => p.onChange({ ...c, enabled: e.target.checked })}
          />{' '}
          on
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        {p.status ? (
          <span
            className={`pill ${p.status.lastOkAt && (!p.status.lastFailAt || p.status.lastOkAt > p.status.lastFailAt) ? 'ok' : p.status.lastFailAt ? 'crit' : ''}`}
          >
            {p.status.lastOkAt
              ? `ok ${fmtDuration(Date.now() - p.status.lastOkAt)} ago`
              : 'never delivered'}
            {p.status.lastFailAt && (!p.status.lastOkAt || p.status.lastFailAt > p.status.lastOkAt)
              ? ` · failing: ${p.status.lastError ?? ''}`
              : ''}
          </span>
        ) : null}
        <button type="button" className="btn quiet" onClick={p.onRemove}>
          Remove
        </button>
      </div>
      <p className="small muted">{info?.help}</p>
      {c.kind === 'ntfy' ? (
        <>
          {field('Topic URL', 'url', 'url')}
          {field('Access token (optional)', 'token', 'password')}
        </>
      ) : null}
      {c.kind === 'pushover' ? (
        <>
          {field('Application token', 'token', 'password')}
          {field('User key', 'user', 'password')}
        </>
      ) : null}
      {c.kind === 'telegram' ? (
        <>
          {field('Bot token', 'botToken', 'password')}
          {field('Chat id', 'chatId')}
        </>
      ) : null}
      {c.kind === 'webhook' ? (
        <>
          {field('URL', 'url', 'url')}
          <div className="field" style={{ marginBottom: '0.5rem' }}>
            <label>Authorization header (optional)</label>
            <input
              type="password"
              value={c.headers.Authorization ?? ''}
              onChange={(e) =>
                p.onChange({
                  ...c,
                  headers: e.target.value
                    ? { ...c.headers, Authorization: e.target.value }
                    : Object.fromEntries(
                        Object.entries(c.headers).filter(([k]) => k !== 'Authorization'),
                      ),
                })
              }
              autoComplete="off"
            />
          </div>
        </>
      ) : null}
      {c.kind === 'mqtt' ? (
        <>
          {field('Broker URL', 'url')}
          {field('Username', 'username')}
          {field('Password', 'password', 'password')}
          {field('Topic prefix', 'topicPrefix')}
        </>
      ) : null}
      {c.kind === 'email' ? field('To', 'to') : null}
      <div className="row small">
        <span className="muted">Send:</span>
        {SEVERITIES.map((sev) => (
          <label key={sev} className="checkbox" style={{ minHeight: 0 }}>
            <input
              type="checkbox"
              checked={c.severities.includes(sev)}
              onChange={(e) =>
                p.onChange({
                  ...c,
                  severities: e.target.checked
                    ? [...c.severities, sev]
                    : c.severities.filter((s) => s !== sev),
                })
              }
            />
            {sev}
          </label>
        ))}
      </div>
    </div>
  );
}

function stringField(c: ChannelTarget, key: string): string {
  const v = (c as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}
