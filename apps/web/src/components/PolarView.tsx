import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  fromLocalXY,
  metresPerPixel,
  metresToFeet,
  normaliseAngle,
  radToDeg,
  tileOrigin,
  tilesCovering,
  toLocalXY,
  type LatLon,
  type WatchStateName,
} from '@rode/core';
import type { AisTargetView, Units, ZoneRecord } from '@rode/protocol';
import { fmtBearing, fmtDepth, fmtDuration, fmtRange, fmtSpeed } from '../lib/format.js';

/*
 * Schematic polar view: anchor at centre, swing circle, warning ring, boat
 * rotated to heading, track, north indicator, distance rings, exclusion
 * zones, AIS targets (with their last hour of track when asked), apparent
 * wind on the outer ring. North-up. With an imagery source selected,
 * satellite tiles fill the square under all of it; without one it stands
 * alone, because on a bad cell link it *is* the display.
 *
 * Everything is projected onto a local tangent plane at the anchor (or the
 * boat, when there is no session). Metres → SVG units via one scale factor.
 * The view's extent is a half-width in metres: either supplied by the
 * caller (a shared preference) or derived from what is on screen.
 */

export interface TrackPoint {
  lat: number;
  lon: number;
}

export interface PreviousAnchor {
  anchor: LatLon;
  swingRadius: number | null;
  endedAt: number | null;
}

export interface WindInfo {
  /** Apparent wind angle relative to the bow, radians, positive to starboard. */
  awa: number | null;
  /** Apparent wind speed, m/s. */
  aws: number | null;
  stale: boolean;
}

export interface PolarViewProps {
  state: WatchStateName;
  /** Centre of the circle: the anchor. Null when idle. */
  anchor: LatLon | null;
  swingRadius: number | null;
  warnRadius: number | null;
  /** Boat's bow-roller position. */
  boat: LatLon | null;
  headingRad: number | null;
  positionStale: boolean;
  track: TrackPoint[];
  zones: ZoneRecord[];
  ais: AisTargetView[];
  units: Units;
  /** Set position at "anchor set", drawn as a dashed rode line reference. */
  setPosition?: LatLon | null;
  /** When provided the anchor glyph can be dragged; called on release. */
  onNudge?: (anchor: LatLon) => void;
  nudgeMode?: boolean;
  showAis?: boolean;
  /** Drawing mode: taps append vertices to this polygon and call onTap. */
  drawing?: LatLon[] | undefined;
  onTap?: ((pos: LatLon) => void) | undefined;
  /** Apparent wind for the outer-ring arrow and the top-right readout. */
  wind?: WindInfo | undefined;
  /** Live depth for the readout under the wind speed. */
  depth?: { value: number | null; stale: boolean } | undefined;
  /** The circle actually being watched is manual; labels say so. */
  manualRadius?: boolean | undefined;
  /** Write the two radii on their rings (the Watch screen does, Traffic does not). */
  radiusLabels?: boolean | undefined;
  /** Circle editing: drag either ring. Values in metres. */
  editRadius?:
    | {
        onDrag: (which: 'swing' | 'warn', metres: number) => void;
        onCommit: (which: 'swing' | 'warn', metres: number) => void;
      }
    | undefined;
  /** Where the last session's anchor was; drawn greyed. */
  previousAnchor?: PreviousAnchor | null | undefined;
  /** Widen the automatic extent to include every AIS target. */
  fitAis?: boolean | undefined;
  /** Imagery source id for /api/tiles, with its zoom range. */
  imagery?: { id: string; minZoom: number; maxZoom: number } | null | undefined;
  night?: boolean | undefined;
  /** Rendered width in CSS px, used to pick a tile zoom. Defaults to 600. */
  pixelWidth?: number | undefined;
  /**
   * Half-width of the view in metres. `null` (or omitted) means automatic.
   * With `onRangeChange` the zoom buttons report instead of changing local
   * state, so the caller can persist the choice.
   */
  range?: number | null | undefined;
  onRangeChange?: ((metres: number) => void) | undefined;
  /** Recent positions of AIS targets to draw, keyed by MMSI. */
  aisTracks?: Record<string, TrackPoint[]> | undefined;
  /** Server time, for "seen … ago" in the target box. */
  now?: number | undefined;
}

const SIZE = 600; // SVG viewBox
const HALF = SIZE / 2;
/** Compass ticks live just inside the edge. */
const ROSE_R = HALF - 18;
/** Extent limits: a boat length in, 100 nautical miles out. */
export const MIN_RANGE_M = 10;
export const MAX_RANGE_M = 100 * 1852;
const MAX_TILES = 90;
const NM = 1852;

/**
 * The extent the view picks for itself: the circle with room around it, or
 * the track, or every AIS target when asked. Exported so a screen can
 * freeze it into a preference when the user turns "fit all" off.
 */
export function autoRange(p: {
  swingRadius: number | null;
  origin: LatLon | null;
  track: TrackPoint[];
  fitAis: boolean;
  ais: AisTargetView[];
}): number {
  let half = 40;
  if (p.swingRadius !== null && p.swingRadius > 0) half = p.swingRadius * 1.35;
  else if (p.origin) {
    for (const t of p.track) {
      const xy = toLocalXY(p.origin, t);
      half = Math.max(half, Math.hypot(xy.x, xy.y) * 1.2);
    }
  }
  if (p.fitAis && p.origin) {
    for (const t of p.ais) {
      if (t.lat === null || t.lon === null) continue;
      const xy = toLocalXY(p.origin, { lat: t.lat, lon: t.lon });
      // Ignore anything absurdly far (a rebroadcast from another coast).
      const d = Math.hypot(xy.x, xy.y);
      if (d < MAX_RANGE_M) half = Math.max(half, d * 1.15);
    }
  }
  return Math.min(MAX_RANGE_M, Math.max(MIN_RANGE_M, half));
}

/**
 * Ring spacing that yields 3–6 rings: metres or feet close in, nautical
 * miles once a ring would be more than 1000 ft / 1000 m apart.
 */
function niceRing(metresPerHalf: number, feet: boolean): number {
  const target = metresPerHalf / 3.5;
  const nmFrom = feet ? 1000 * 0.3048 : 1000;
  if (target > nmFrom) {
    const nm = [0.5, 1, 2, 5, 10, 20, 50];
    const chosen = nm.find((c) => c * NM >= target) ?? 50;
    return chosen * NM;
  }
  const candidates = feet
    ? [25, 50, 100, 200, 250, 500, 1000]
    : [5, 10, 20, 25, 50, 100, 200, 500, 1000];
  const toDisplay = feet ? metresToFeet(target) : target;
  const chosen = candidates.find((c) => c >= toDisplay) ?? candidates[candidates.length - 1] ?? 50;
  return feet ? chosen * 0.3048 : chosen;
}

type Drag = { kind: 'anchor'; x: number; y: number } | { kind: 'swing' | 'warn'; metres: number };

export function PolarView(p: PolarViewProps) {
  const [localRange, setLocalRange] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hoverAis, setHoverAis] = useState<string | null>(null);
  const [pinnedAis, setPinnedAis] = useState<string | null>(null);

  const origin = p.anchor ?? p.boat;
  const feet = p.units.distance === 'ft';
  const interactive = Boolean(p.nudgeMode) || p.onTap !== undefined || p.editRadius !== undefined;
  const controlled = p.onRangeChange !== undefined;

  const auto = useMemo(
    () =>
      autoRange({
        swingRadius: p.swingRadius,
        origin,
        track: p.track,
        fitAis: p.fitAis ?? false,
        ais: p.ais,
      }),
    [p.swingRadius, origin, p.track, p.fitAis, p.ais],
  );
  const chosen = controlled ? (p.range ?? null) : localRange;
  const half = Math.min(MAX_RANGE_M, Math.max(MIN_RANGE_M, chosen ?? auto));
  const scale = HALF / half; // svg units per metre
  const setRange = (m: number) => {
    const clamped = Math.min(MAX_RANGE_M, Math.max(MIN_RANGE_M, m));
    if (controlled) p.onRangeChange?.(clamped);
    else setLocalRange(clamped);
  };

  const toSvg = useCallback(
    (pos: LatLon): { x: number; y: number } | null => {
      if (!origin) return null;
      const xy = toLocalXY(origin, pos);
      return { x: HALF + xy.x * scale, y: HALF - xy.y * scale };
    },
    [origin, scale],
  );
  const fromSvg = useCallback(
    (pt: { x: number; y: number }): LatLon | null =>
      origin ? fromLocalXY(origin, { x: (pt.x - HALF) / scale, y: (HALF - pt.y) / scale }) : null,
    [origin, scale],
  );

  const ringM = niceRing(half, feet);
  const rings: number[] = [];
  for (let r = ringM; r < half * 1.42; r += ringM) rings.push(r);

  const boatSvg = p.boat ? toSvg(p.boat) : null;
  const setSvg = p.setPosition ? toSvg(p.setPosition) : null;
  const pathFor = useCallback(
    (track: TrackPoint[]): string => {
      if (!origin || track.length < 2) return '';
      return track
        .map((t, i) => {
          const s = toSvg(t);
          return s ? `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)} ${s.y.toFixed(1)}` : '';
        })
        .join(' ');
    },
    [origin, toSvg],
  );
  const trackPath = useMemo(() => pathFor(p.track), [pathFor, p.track]);
  const aisPaths = useMemo(() => {
    const out: { mmsi: string; d: string }[] = [];
    for (const [mmsi, track] of Object.entries(p.aisTracks ?? {})) {
      const d = pathFor(track);
      if (d) out.push({ mmsi, d });
    }
    return out;
  }, [pathFor, p.aisTracks]);

  const anchorSvg = p.anchor ? toSvg(p.anchor) : null;
  const anchorDraw = drag?.kind === 'anchor' ? { x: drag.x, y: drag.y } : anchorSvg;
  const swingM = drag?.kind === 'swing' ? drag.metres : p.swingRadius;
  const warnM = drag?.kind === 'warn' ? drag.metres : p.warnRadius;

  // ---------------------------------------------------------------- imagery
  const tiles = useMemo(() => {
    if (!p.imagery || !origin) return null;
    const px = p.pixelWidth ?? SIZE;
    // Metres per rendered pixel; pick the zoom whose tiles are about that fine.
    const mpp = (half * 2) / px;
    let z = Math.round(Math.log2((156543.03392 * Math.cos((origin.lat * Math.PI) / 180)) / mpp));
    z = Math.max(p.imagery.minZoom, Math.min(p.imagery.maxZoom, z));
    let cover = tilesCovering(origin, half * 1.02, z);
    while ((cover.x1 - cover.x0 + 1) * (cover.y1 - cover.y0 + 1) > MAX_TILES && z > 0) {
      z -= 1;
      cover = tilesCovering(origin, half * 1.02, z);
    }
    const out: { key: string; href: string; x: number; y: number; w: number; h: number }[] = [];
    for (let x = cover.x0; x <= cover.x1; x++) {
      for (let y = cover.y0; y <= cover.y1; y++) {
        const nw = toSvg(tileOrigin({ z, x, y }));
        const se = toSvg(tileOrigin({ z, x: x + 1, y: y + 1 }));
        if (!nw || !se) continue;
        out.push({
          key: `${String(z)}/${String(x)}/${String(y)}`,
          href: `/api/tiles/${p.imagery.id}/${String(z)}/${String(x)}/${String(y)}`,
          // A hair of overlap hides the seams between fractional-pixel tiles.
          x: nw.x,
          y: nw.y,
          w: se.x - nw.x + 0.7,
          h: se.y - nw.y + 0.7,
        });
      }
    }
    return { z, mpp: metresPerPixel(origin.lat, z), list: out };
  }, [p.imagery, origin, half, toSvg, p.pixelWidth]);

  // ---------------------------------------------------------------- wind
  // Absolute direction the wind comes from: heading + AWA. Without a heading
  // the arrow cannot be placed and the readout says so.
  const awa = p.wind?.awa ?? null;
  const windDir = awa !== null && p.headingRad !== null ? normaliseAngle(p.headingRad + awa) : null;

  // ---------------------------------------------------------------- pointer
  const svgPoint = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pt = svgPoint(e);
    if (!pt) return;
    // The zoom buttons live in the top-right corner of the wrapper.
    if (pt.x > SIZE - 80 && pt.y < 100) return;
    if (p.editRadius && anchorSvg && (swingM !== null || warnM !== null)) {
      const d = Math.hypot(pt.x - anchorSvg.x, pt.y - anchorSvg.y);
      const grab = 22;
      const nearSwing = swingM !== null && Math.abs(d - swingM * scale) < grab;
      const nearWarn = warnM !== null && Math.abs(d - warnM * scale) < grab;
      // When both rings are within reach take the closer one.
      let which: 'swing' | 'warn' | null = null;
      if (nearSwing && nearWarn)
        which = Math.abs(d - swingM * scale) <= Math.abs(d - warnM * scale) ? 'swing' : 'warn';
      else if (nearSwing) which = 'swing';
      else if (nearWarn) which = 'warn';
      if (which) {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ kind: which, metres: d / scale });
        return;
      }
    }
    if (p.onTap && origin && !p.nudgeMode) {
      const pos = fromSvg(pt);
      if (pos) p.onTap(pos);
      return;
    }
    if (!p.nudgeMode || !anchorSvg) return;
    if (Math.hypot(pt.x - anchorSvg.x, pt.y - anchorSvg.y) < 40) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ kind: 'anchor', x: pt.x, y: pt.y });
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const pt = svgPoint(e);
    if (!pt) return;
    if (drag.kind === 'anchor') {
      setDrag({ kind: 'anchor', x: pt.x, y: pt.y });
      return;
    }
    if (!anchorSvg) return;
    const metres = Math.max(1, Math.hypot(pt.x - anchorSvg.x, pt.y - anchorSvg.y) / scale);
    setDrag({ kind: drag.kind, metres });
    p.editRadius?.onDrag(drag.kind, metres);
  };
  const onPointerUp = () => {
    if (!drag) return;
    if (drag.kind === 'anchor') {
      const pos = fromSvg({ x: drag.x, y: drag.y });
      if (pos && p.onNudge) p.onNudge(pos);
    } else {
      p.editRadius?.onCommit(drag.kind, Math.round(drag.metres * 10) / 10);
    }
    setDrag(null);
  };

  const fmtRing = (m: number): string => {
    if (m >= (feet ? 1000 * 0.3048 : 1000)) {
      const nm = m / NM;
      return `${nm < 1 ? nm.toFixed(1) : nm.toFixed(0)} nm`;
    }
    return feet ? `${Math.round(metresToFeet(m))} ft` : `${Math.round(m)} m`;
  };
  const fmtRingDp = (m: number) =>
    feet ? `${metresToFeet(m).toFixed(m < 30 ? 1 : 0)} ft` : `${m.toFixed(m < 100 ? 1 : 0)} m`;

  // Ring label positions: alarm on the SE diagonal, warning on the SW, so
  // they never sit on top of each other however close the rings are.
  const diag = Math.SQRT1_2;
  const prev = p.previousAnchor ? toSvg(p.previousAnchor.anchor) : null;
  const selectedAis = pinnedAis ?? hoverAis;
  const selectedTarget = selectedAis ? p.ais.find((t) => t.mmsi === selectedAis) : undefined;
  const labels = p.radiusLabels ?? true;

  return (
    <div className="polar-wrap" data-interactive={interactive ? 'true' : 'false'}>
      <svg
        ref={svgRef}
        className={p.night ? 'polar night' : 'polar'}
        data-state={p.state}
        viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
        role="img"
        aria-label={
          p.anchor
            ? `Anchor view. Alarm radius ${fmtRing(p.swingRadius ?? 0)}. Boat ${p.boat ? fmtRing(distance(p.anchor, p.boat)) : 'unknown'} from anchor.`
            : 'Position view, no anchor session.'
        }
        // Vertical swipes scroll the page unless a drag mode is active.
        style={{ touchAction: interactive ? 'none' : 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {/* imagery under everything, across the whole square */}
        {tiles ? (
          <g className="imagery">
            <rect className="imagery-bg" x={0} y={0} width={SIZE} height={SIZE} />
            {tiles.list.map((t) => (
              <image
                key={t.key}
                href={t.href}
                x={t.x}
                y={t.y}
                width={t.w}
                height={t.h}
                preserveAspectRatio="none"
              />
            ))}
          </g>
        ) : null}

        {/* distance rings */}
        <g className="rings">
          {rings.map((r) => (
            <g key={r}>
              <circle className="ring" cx={HALF} cy={HALF} r={r * scale} />
              <text className="ring-label" x={HALF + 4} y={HALF - r * scale - 3}>
                {fmtRing(r)}
              </text>
            </g>
          ))}
        </g>

        {/* compass ticks every 30° */}
        <g className="compass">
          {Array.from({ length: 12 }, (_, i) => i * 30).map((deg) => {
            const a = ((deg - 90) * Math.PI) / 180;
            const r1 = HALF - 14;
            const r2 = HALF - 6;
            return (
              <g key={deg}>
                <line
                  className="ring"
                  x1={HALF + Math.cos(a) * r1}
                  y1={HALF + Math.sin(a) * r1}
                  x2={HALF + Math.cos(a) * r2}
                  y2={HALF + Math.sin(a) * r2}
                />
                {deg % 90 === 0 && deg !== 0 ? (
                  <text
                    x={HALF + Math.cos(a) * (HALF - 26)}
                    y={HALF + Math.sin(a) * (HALF - 26) + 4}
                    textAnchor="middle"
                  >
                    {deg === 90 ? 'E' : deg === 180 ? 'S' : 'W'}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>

        {/* north */}
        <g className="north">
          <path d={`M${String(HALF)} 14 l6 16 h-12 z`} />
          <text x={HALF} y={44} textAnchor="middle">
            N
          </text>
        </g>

        {/* apparent wind: arrow on the outer ring pointing in, from where it blows */}
        {windDir !== null && p.wind ? (
          <g
            className={p.wind.stale ? 'wind stale' : 'wind'}
            transform={`rotate(${radToDeg(windDir).toFixed(1)} ${String(HALF)} ${String(HALF)})`}
          >
            <path d={`M${String(HALF)} ${String(HALF - ROSE_R + 2)} l-11 -22 h22 z`} />
            <line
              x1={HALF}
              y1={HALF - ROSE_R - 20}
              x2={HALF}
              y2={HALF - ROSE_R - 30}
              className="wind-stem"
            />
          </g>
        ) : null}

        {/* exclusion zones */}
        {origin
          ? p.zones
              .filter((z) => z.enabled)
              .map((z) => {
                const pts = z.polygon
                  .map((v) => toSvg(v))
                  .filter((v): v is { x: number; y: number } => v !== null);
                if (pts.length < 3) return null;
                return (
                  <polygon
                    key={z.id}
                    className={`zone ${z.kind === 'must-stay-inside' ? 'stay' : ''}`}
                    points={pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}
                  >
                    <title>{z.name}</title>
                  </polygon>
                );
              })
          : null}

        {/* polygon being drawn */}
        {p.drawing && p.drawing.length > 0
          ? (() => {
              const pts = p.drawing
                .map((v) => toSvg(v))
                .filter((v): v is { x: number; y: number } => v !== null);
              return (
                <g className="drawing">
                  {pts.length >= 3 ? (
                    <polygon
                      className="zone"
                      points={pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}
                    />
                  ) : pts.length === 2 ? (
                    <line
                      className="rode-line"
                      x1={pts[0]?.x}
                      y1={pts[0]?.y}
                      x2={pts[1]?.x}
                      y2={pts[1]?.y}
                    />
                  ) : null}
                  {pts.map((q, i) => (
                    <circle key={i} className="boat" cx={q.x} cy={q.y} r={5} />
                  ))}
                </g>
              );
            })()
          : null}

        {/* previous session's anchor, greyed */}
        {prev ? (
          <g
            className="previous"
            transform={`translate(${prev.x.toFixed(1)} ${prev.y.toFixed(1)})`}
          >
            {p.previousAnchor?.swingRadius ? (
              <circle className="prev-swing" r={p.previousAnchor.swingRadius * scale} />
            ) : null}
            <g className="anchor prev-anchor">
              <circle r={3} cy={-11} />
              <line x1={0} y1={-8} x2={0} y2={10} />
              <line x1={-7} y1={-3} x2={7} y2={-3} />
              <path d="M-10 4 Q0 14 10 4" />
            </g>
            <text className="prev-label" x={12} y={4}>
              previous anchor
            </text>
          </g>
        ) : null}

        {/* swing circle + warning ring */}
        {anchorDraw && swingM !== null ? (
          <>
            {warnM !== null && warnM > 0 ? (
              <>
                <circle
                  className={drag?.kind === 'warn' ? 'warn-ring dragging' : 'warn-ring'}
                  cx={anchorDraw.x}
                  cy={anchorDraw.y}
                  r={warnM * scale}
                />
                {labels ? (
                  <text
                    className="radius-label warn"
                    x={anchorDraw.x - warnM * scale * diag - 4}
                    y={anchorDraw.y + warnM * scale * diag + 14}
                    textAnchor="end"
                  >
                    warning {fmtRingDp(warnM)}
                  </text>
                ) : null}
              </>
            ) : null}
            <circle
              className={drag?.kind === 'swing' ? 'swing dragging' : 'swing'}
              cx={anchorDraw.x}
              cy={anchorDraw.y}
              r={swingM * scale}
            />
            {labels ? (
              <text
                className="radius-label alarm"
                x={anchorDraw.x + swingM * scale * diag + 4}
                y={anchorDraw.y + swingM * scale * diag + 14}
              >
                alarm {fmtRingDp(swingM)}
                {p.manualRadius ? ' · manual' : ''}
              </text>
            ) : null}
            {p.editRadius ? (
              <g className="edit-handles">
                <circle cx={anchorDraw.x + swingM * scale} cy={anchorDraw.y} r={9} />
                {warnM !== null && warnM > 0 ? (
                  <circle cx={anchorDraw.x - warnM * scale} cy={anchorDraw.y} r={9} />
                ) : null}
              </g>
            ) : null}
          </>
        ) : null}

        {/* rode reference from anchor to set position */}
        {anchorDraw && setSvg ? (
          <line
            className="rode-line"
            x1={anchorDraw.x}
            y1={anchorDraw.y}
            x2={setSvg.x}
            y2={setSvg.y}
          />
        ) : null}

        {/* track */}
        {trackPath ? <path className="track" d={trackPath} /> : null}

        {/* AIS tracks, then targets */}
        {p.showAis
          ? aisPaths.map((t) => <path key={t.mmsi} className="ais-track" d={t.d} />)
          : null}
        {p.showAis
          ? p.ais.map((t) => {
              if (t.lat === null || t.lon === null) return null;
              const s = toSvg({ lat: t.lat, lon: t.lon });
              if (!s || s.x < -20 || s.y < -20 || s.x > SIZE + 20 || s.y > SIZE + 20) return null;
              const rot = t.cog !== null ? radToDeg(t.cog) : 0;
              const selected = selectedAis === t.mmsi;
              return (
                <g
                  key={t.mmsi}
                  className={selected ? 'ais-target selected' : 'ais-target'}
                  transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`}
                  onPointerEnter={(e) => {
                    if (e.pointerType === 'mouse') setHoverAis(t.mmsi);
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === 'mouse') setHoverAis(null);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinnedAis((cur) => (cur === t.mmsi ? null : t.mmsi));
                  }}
                >
                  {/* A generous invisible hit area for fingers. */}
                  <circle className="ais-hit" r={18} />
                  <path
                    className="ais"
                    d="M0 -9 L6 7 L0 4 L-6 7 Z"
                    transform={`rotate(${rot.toFixed(1)})`}
                  />
                  <text className="ais-label" x={9} y={4}>
                    {t.name ?? t.mmsi}
                  </text>
                </g>
              );
            })
          : null}

        {/* anchor glyph */}
        {anchorDraw ? (
          <g
            className="anchor-g"
            transform={`translate(${anchorDraw.x.toFixed(1)} ${anchorDraw.y.toFixed(1)})`}
          >
            {p.nudgeMode ? <circle className="nudge-hint" r={34} /> : null}
            <g className="anchor">
              <circle r={3} cy={-11} />
              <line x1={0} y1={-8} x2={0} y2={10} />
              <line x1={-7} y1={-3} x2={7} y2={-3} />
              <path d="M-10 4 Q0 14 10 4" />
            </g>
          </g>
        ) : null}

        {/* boat */}
        {boatSvg ? (
          <g transform={`translate(${boatSvg.x.toFixed(1)} ${boatSvg.y.toFixed(1)})`}>
            {p.headingRad !== null ? (
              <g transform={`rotate(${radToDeg(p.headingRad).toFixed(1)})`}>
                <path className="boat" d="M0 -14 C6 -8 7 2 5 10 L-5 10 C-7 2 -6 -8 0 -14 Z" />
                <line className="boat-heading" x1={0} y1={-14} x2={0} y2={-26} />
              </g>
            ) : (
              <circle className="boat" r={7} />
            )}
          </g>
        ) : null}

        {p.positionStale ? (
          <rect
            className="stale-shade"
            x={0}
            y={0}
            width={SIZE}
            height={SIZE}
            pointerEvents="none"
          />
        ) : null}
      </svg>

      <div className="polar-overlay" aria-hidden="true">
        <span className="scale">rings {fmtRing(ringM)}</span>
        {tiles ? <span>imagery z{tiles.z}</span> : null}
        {p.positionStale ? <span>position stale</span> : null}
        {p.nudgeMode ? <span>drag the anchor</span> : null}
        {p.editRadius ? <span>drag a ring to resize</span> : null}
        {p.onTap ? <span>tap to add a point</span> : null}
      </div>

      {p.wind || p.depth ? (
        <div className="polar-readouts num" aria-label="Wind and depth">
          {p.wind ? (
            <div className={p.wind.stale ? 'pr stale' : 'pr'}>
              <span className="pr-label">
                wind {windDir !== null ? `${fmtBearing(windDir).value}°` : ''}
              </span>
              <span className="pr-value">
                {fmtSpeed(p.wind.aws, p.units).value}
                <span className="pr-unit">{fmtSpeed(p.wind.aws, p.units).unit}</span>
              </span>
              {windDir === null && awa !== null ? (
                <span className="pr-note">no heading</span>
              ) : null}
            </div>
          ) : null}
          {p.depth ? (
            <div className={p.depth.stale ? 'pr stale' : 'pr'}>
              <span className="pr-label">depth</span>
              <span className="pr-value">
                {fmtDepth(p.depth.value, p.units).value}
                <span className="pr-unit">{fmtDepth(p.depth.value, p.units).unit}</span>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {selectedTarget ? (
        <AisBox
          t={selectedTarget}
          units={p.units}
          now={p.now}
          pinned={pinnedAis === selectedTarget.mmsi}
          onClose={() => {
            setPinnedAis(null);
            setHoverAis(null);
          }}
        />
      ) : null}

      <div className="polar-controls">
        <button type="button" aria-label="Zoom in" onClick={() => setRange(half / 1.5)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => setRange(half * 1.5)}>
          −
        </button>
      </div>
    </div>
  );
}

/** The concise card for a hovered or tapped AIS target. */
function AisBox(p: {
  t: AisTargetView;
  units: Units;
  now: number | undefined;
  pinned: boolean;
  onClose: () => void;
}) {
  const { t } = p;
  const range = fmtRange(t.range, p.units);
  const cpa = fmtRange(t.cpa, p.units);
  const sog = fmtSpeed(t.sog, p.units);
  const seen = p.now !== undefined ? fmtDuration(Math.max(0, p.now - t.lastSeen)) : null;
  return (
    <div className="ais-box num" role="status">
      <div className="ais-box-head">
        <strong>{t.name ?? t.mmsi}</strong>
        {p.pinned ? (
          <button type="button" className="ais-box-close" aria-label="Close" onClick={p.onClose}>
            ×
          </button>
        ) : null}
      </div>
      <div className="ais-box-sub">
        {t.mmsi} · class {t.class}
        {t.callsign ? ` · ${t.callsign}` : ''}
        {t.navStatus === 1 ? ' · anchored' : t.navStatus === 5 ? ' · moored' : ''}
      </div>
      <dl>
        <dt>Range</dt>
        <dd>
          {range.value} {range.unit}
          {t.bearing !== null ? ` at ${fmtBearing(t.bearing).value}°` : ''}
        </dd>
        <dt>SOG / COG</dt>
        <dd>
          {sog.value} {sog.unit} / {fmtBearing(t.cog).value}°
        </dd>
        <dt>CPA</dt>
        <dd>
          {cpa.value} {cpa.unit}
          {t.tcpa === null
            ? ''
            : t.tcpa <= 0
              ? ' · diverging'
              : ` in ${fmtDuration(t.tcpa * 1000)}`}
        </dd>
        {seen !== null ? (
          <>
            <dt>Seen</dt>
            <dd>{seen} ago</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function distance(a: LatLon, b: LatLon): number {
  const xy = toLocalXY(a, b);
  return Math.hypot(xy.x, xy.y);
}
