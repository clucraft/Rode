import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { EventRecord, SessionSummary, TrackPoint } from '@rode/protocol';
import { api, errorMessage } from '../api/client.js';
import { useAuth } from '../api/auth.js';
import {
  DEFAULT_UNITS,
  fmtDateTime,
  fmtDepth,
  fmtDistance,
  fmtDuration,
  fmtRode,
  fmtScope,
  fmtSpeed,
  fmtTime,
} from '../lib/format.js';
import { PolarView } from '../components/PolarView.jsx';
import { Spinner } from '../components/common.js';

/*
 * Past sessions with their geometry and event log, and charts of the night.
 * Everything here is read from the server; nothing is recomputed.
 */

export function History() {
  const [data, setData] = useState<{ total: number; sessions: SessionSummary[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { settings } = useAuth();
  const units = settings?.units ?? DEFAULT_UNITS;
  useEffect(() => {
    api
      .get<{ total: number; sessions: SessionSummary[] }>('/api/sessions?limit=100')
      .then(setData)
      .catch((e: unknown) => setErr(errorMessage(e)));
  }, []);
  if (err) return <p className="error">{err}</p>;
  if (!data) return <Spinner />;
  if (data.sessions.length === 0)
    return <p className="muted">No sessions yet. The first drop will appear here.</p>;
  return (
    <div className="scroll-x">
      <table className="table num">
        <thead>
          <tr>
            <th>Started</th>
            <th>Mode</th>
            <th>Duration</th>
            <th className="num">Radius</th>
            <th className="num">Scope</th>
            <th className="num">Max dist</th>
            <th className="num">Warn / alarm</th>
          </tr>
        </thead>
        <tbody>
          {data.sessions.map((s) => {
            const g = s.geometry as { swingRadius?: number; scopeRatio?: number } | null;
            return (
              <tr key={s.id}>
                <td>
                  <Link to={`/history/${s.id}`}>
                    {fmtDateTime(s.startedAt, settings?.timeZone)}
                  </Link>
                </td>
                <td>{s.mode}</td>
                <td>{s.endedAt ? fmtDuration(s.endedAt - s.startedAt) : 'active'}</td>
                <td className="num">{fmtDistance(g?.swingRadius, units).value}</td>
                <td className="num">{s.mode === 'anchor' ? fmtScope(g?.scopeRatio).value : '—'}</td>
                <td className="num">{fmtDistance(s.maxDistance, units).value}</td>
                <td className="num">
                  {s.warningCount} / {s.alarmCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Series {
  at: number;
  lat: number | null;
  lon: number | null;
  sog: number | null;
  depth: number | null;
  aws: number | null;
  distance: number | null;
}

export function SessionDetail() {
  const { id } = useParams();
  const { settings } = useAuth();
  const units = settings?.units ?? DEFAULT_UNITS;
  const [detail, setDetail] = useState<{
    session: SessionSummary;
    events: EventRecord[];
    track: TrackPoint[];
  } | null>(null);
  const [series, setSeries] = useState<Series[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .get<{ session: SessionSummary; events: EventRecord[]; track: TrackPoint[] }>(
        `/api/sessions/${id}`,
      )
      .then((d) => {
        setDetail(d);
        const to = d.session.endedAt ?? Date.now();
        return api
          .get<Series[]>(`/api/series?from=${d.session.startedAt}&to=${to}&limit=5000`)
          .then(setSeries);
      })
      .catch((e: unknown) => setErr(errorMessage(e)));
  }, [id]);

  if (err) return <p className="error">{err}</p>;
  if (!detail) return <Spinner />;
  const { session, events, track } = detail;
  const g = session.geometry as null | {
    swingRadius: number;
    warnRadius: number;
    rodeLength: number;
    scopeRatio: number;
    scopeRatioAtHighWater: number;
    depthAtDrop: number;
    horizontalRun: number;
    tideRange: number;
  };

  return (
    <div className="stack">
      <p>
        <Link to="/history">← All sessions</Link>
      </p>
      <h1>
        {session.mode === 'marina' ? 'Marina watch' : 'Anchor session'} ·{' '}
        {fmtDateTime(session.startedAt, settings?.timeZone)}
      </h1>
      <p className="muted">
        {session.endedAt
          ? `${fmtDuration(session.endedAt - session.startedAt)}, ended by ${session.endedBy ?? 'unknown'}`
          : 'still active'}{' '}
        · {session.warningCount} warnings, {session.alarmCount} alarms
      </p>

      {g ? (
        <div className="readouts num">
          <div className="readout">
            <span className="label">Radius</span>
            <span className="value">
              {fmtDistance(g.swingRadius, units).value}
              <span className="unit">{fmtDistance(g.swingRadius, units).unit}</span>
            </span>
          </div>
          <div className="readout">
            <span className="label">Rode</span>
            <span className="value">
              {fmtRode(g.rodeLength, units).value}
              <span className="unit">{fmtRode(g.rodeLength, units).unit}</span>
            </span>
          </div>
          <div className="readout">
            <span className="label">Scope</span>
            <span className="value">
              {fmtScope(g.scopeRatio).value}
              <span className="unit">:1</span>
            </span>
            {g.tideRange > 0 ? (
              <span className="sub">{fmtScope(g.scopeRatioAtHighWater).value}:1 at high water</span>
            ) : null}
          </div>
          <div className="readout">
            <span className="label">Depth at drop</span>
            <span className="value">
              {fmtDepth(g.depthAtDrop, units).value}
              <span className="unit">{fmtDepth(g.depthAtDrop, units).unit}</span>
            </span>
          </div>
          <div className="readout">
            <span className="label">Max distance</span>
            <span className="value">
              {fmtDistance(session.maxDistance, units).value}
              <span className="unit">{fmtDistance(session.maxDistance, units).unit}</span>
            </span>
          </div>
        </div>
      ) : null}

      <PolarView
        state={session.alarmCount > 0 ? 'ALARM' : session.warningCount > 0 ? 'WARNING' : 'SET'}
        anchor={session.anchor}
        swingRadius={g?.swingRadius ?? null}
        warnRadius={g?.warnRadius ?? null}
        boat={
          track.length > 0
            ? { lat: track[track.length - 1]?.lat ?? 0, lon: track[track.length - 1]?.lon ?? 0 }
            : null
        }
        headingRad={null}
        positionStale={false}
        track={track}
        zones={[]}
        ais={[]}
        units={units}
      />

      {series.length > 5 ? (
        <section className="section">
          <h2>The night</h2>
          <Chart
            title="Distance from anchor"
            series={series}
            pick={(s) => s.distance}
            fmt={(v) => `${fmtDistance(v, units).value} ${fmtDistance(v, units).unit}`}
            ref1={g?.swingRadius ?? null}
            ref2={g?.warnRadius ?? null}
            tz={settings?.timeZone}
          />
          <Chart
            title="Depth"
            series={series}
            pick={(s) => s.depth}
            fmt={(v) => `${fmtDepth(v, units).value} ${fmtDepth(v, units).unit}`}
            tz={settings?.timeZone}
          />
          <Chart
            title="Apparent wind"
            series={series}
            pick={(s) => s.aws}
            fmt={(v) => `${fmtSpeed(v, units).value} ${fmtSpeed(v, units).unit}`}
            tz={settings?.timeZone}
          />
          <Chart
            title="SOG"
            series={series}
            pick={(s) => s.sog}
            fmt={(v) => `${fmtSpeed(v, units).value} ${fmtSpeed(v, units).unit}`}
            tz={settings?.timeZone}
          />
        </section>
      ) : null}

      <section className="section">
        <h2>Event log</h2>
        <EventList events={events} tz={settings?.timeZone} />
      </section>
    </div>
  );
}

export function EventList({ events, tz }: { events: EventRecord[]; tz?: string | undefined }) {
  if (events.length === 0) return <p className="muted">Nothing logged.</p>;
  return (
    <ul className="event-list num">
      {events.map((e) => (
        <li key={e.seq}>
          <span className="t">{fmtTime(e.at, tz)}</span>
          <span className={e.severity}>{describeEvent(e)}</span>
        </li>
      ))}
    </ul>
  );
}

export function describeEvent(e: EventRecord): string {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'state-changed':
      return `${String(d.from)} → ${String(d.to)}`;
    case 'condition-raised':
    case 'condition-escalated': {
      const c = d.condition as { id: string; severity: string } | undefined;
      return `${e.type === 'condition-raised' ? 'raised' : 'escalated'} ${c?.id ?? ''} (${c?.severity ?? ''})`;
    }
    case 'condition-cleared':
      return `cleared ${String(d.id)} after ${fmtDuration(Number(d.durationMs))}`;
    case 'anchor-set': {
      const g = d.geometry as
        { swingRadius: number; rodeLength: number; scopeRatio: number } | undefined;
      return g
        ? `anchor set · radius ${g.swingRadius.toFixed(0)} m, rode ${g.rodeLength.toFixed(0)} m, scope ${g.scopeRatio.toFixed(1)}:1`
        : 'anchor set';
    }
    case 'acknowledged':
      return `acknowledged by ${String(d.by)}`;
    case 'alarm-refire':
      return `alarm re-fired (${String(d.refires)})`;
    case 'cold-box-band-changed':
      return `${String(d.box)} ${String(d.from)} → ${String(d.to)}`;
    case 'command-rejected':
      return `${String(d.command)} rejected: ${String(d.message)}`;
    default: {
      const by = typeof d.by === 'string' ? ` by ${d.by}` : '';
      return `${e.type.replace(/-/g, ' ')}${by}`;
    }
  }
}

/** A quiet SVG line chart with optional reference lines. */
function Chart(p: {
  title: string;
  series: Series[];
  pick: (s: Series) => number | null;
  fmt: (v: number) => string;
  ref1?: number | null;
  ref2?: number | null;
  tz?: string | undefined;
}) {
  const W = 640;
  const H = 160;
  const pad = { l: 8, r: 8, t: 8, b: 20 };
  const pts = useMemo(
    () =>
      p.series
        .map((s) => ({ t: s.at, v: p.pick(s) }))
        .filter((q): q is { t: number; v: number } => q.v !== null && Number.isFinite(q.v)),
    [p],
  );
  if (pts.length < 2) return null;
  const t0 = pts[0]?.t ?? 0;
  const t1 = pts[pts.length - 1]?.t ?? 1;
  let vmin = Math.min(...pts.map((q) => q.v), p.ref2 ?? Infinity);
  let vmax = Math.max(...pts.map((q) => q.v), p.ref1 ?? -Infinity);
  if (vmax - vmin < 1e-6) {
    vmin -= 1;
    vmax += 1;
  }
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - ((v - vmin) / (vmax - vmin)) * (H - pad.t - pad.b);
  const path = pts
    .map((q, i) => `${i === 0 ? 'M' : 'L'}${x(q.t).toFixed(1)} ${y(q.v).toFixed(1)}`)
    .join(' ');
  const last = pts[pts.length - 1];
  return (
    <figure style={{ margin: '0 0 1rem' }}>
      <figcaption className="small" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{p.title}</span>
        <span className="num muted">
          {p.fmt(vmin)} – {p.fmt(vmax)}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`${p.title} over the session, from ${p.fmt(pts[0]?.v ?? 0)} to ${p.fmt(last?.v ?? 0)}`}
        style={{ display: 'block' }}
      >
        {p.ref1 !== null && p.ref1 !== undefined ? (
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y(p.ref1)}
            y2={y(p.ref1)}
            stroke="var(--crit)"
            strokeDasharray="4 4"
          />
        ) : null}
        {p.ref2 !== null && p.ref2 !== undefined ? (
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y(p.ref2)}
            y2={y(p.ref2)}
            stroke="var(--warn)"
            strokeDasharray="4 4"
          />
        ) : null}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        <text x={pad.l} y={H - 4} fontSize="11" fill="var(--muted)">
          {fmtTime(t0, p.tz)}
        </text>
        <text x={W - pad.r} y={H - 4} fontSize="11" fill="var(--muted)" textAnchor="end">
          {fmtTime(t1, p.tz)}
        </text>
      </svg>
    </figure>
  );
}
