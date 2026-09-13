import { useMemo } from 'react';
import { fmtTime } from '../lib/format.js';

/*
 * A quiet SVG chart of one value over time, with optional reference lines.
 * `dots` draws points instead of a line: right for directions, where the
 * wrap at 360° would otherwise draw a meaningless vertical stroke.
 */
export function Chart<T extends { at: number }>(p: {
  title: string;
  series: T[];
  pick: (s: T) => number | null;
  fmt: (v: number) => string;
  ref1?: number | null;
  ref2?: number | null;
  tz?: string | undefined;
  dots?: boolean | undefined;
  /** Fixed value range, e.g. [0, 360] for a direction. */
  range?: [number, number] | undefined;
  /** Render this when there are too few points, instead of nothing. */
  empty?: string | undefined;
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
  if (pts.length < 2) {
    return p.empty ? (
      <figure style={{ margin: '0 0 1rem' }}>
        <figcaption className="small">{p.title}</figcaption>
        <p className="muted small">{p.empty}</p>
      </figure>
    ) : null;
  }
  const t0 = pts[0]?.t ?? 0;
  const t1 = pts[pts.length - 1]?.t ?? 1;
  let vmin = p.range ? p.range[0] : Math.min(...pts.map((q) => q.v), p.ref2 ?? Infinity);
  let vmax = p.range ? p.range[1] : Math.max(...pts.map((q) => q.v), p.ref1 ?? -Infinity);
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
          {last ? ` · now ${p.fmt(last.v)}` : ''}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        width="100%"
        role="img"
        aria-label={`${p.title}, from ${p.fmt(pts[0]?.v ?? 0)} to ${p.fmt(last?.v ?? 0)}`}
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
        {p.dots ? (
          pts.map((q, i) => <circle key={i} cx={x(q.t)} cy={y(q.v)} r={1.8} fill="var(--accent)" />)
        ) : (
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        )}
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
