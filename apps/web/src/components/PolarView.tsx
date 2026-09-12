import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  fromLocalXY,
  metresToFeet,
  radToDeg,
  toLocalXY,
  type LatLon,
  type WatchStateName,
} from '@rode/core';
import type { AisTargetView, Units, ZoneRecord } from '@rode/protocol';

/*
 * Schematic polar view: anchor at centre, swing circle, warning ring, boat
 * rotated to heading, track, north indicator, distance rings, exclusion
 * zones, AIS targets. North-up, no basemap. This is not a fallback for the
 * chart; on a bad cell link it *is* the display, so it has to stand alone.
 *
 * Everything is projected onto a local tangent plane at the anchor (or the
 * boat, when there is no session). Metres → SVG units via one scale factor.
 */

export interface TrackPoint {
  lat: number;
  lon: number;
}

export interface PolarViewProps {
  state: WatchStateName;
  /** Centre of the circle: anchor, or marina centre. Null when idle. */
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
}

const SIZE = 600; // SVG viewBox
const HALF = SIZE / 2;

function niceRing(metresPerHalf: number, feet: boolean): number {
  // Pick a ring spacing that yields 3–6 rings in the view.
  const candidates = feet
    ? [25, 50, 100, 200, 250, 500, 1000, 2000]
    : [5, 10, 20, 25, 50, 100, 200, 500, 1000];
  const target = metresPerHalf / 3.5;
  const toDisplay = feet ? metresToFeet(target) : target;
  const chosen = candidates.find((c) => c >= toDisplay) ?? candidates[candidates.length - 1] ?? 50;
  return feet ? chosen * 0.3048 : chosen;
}

export function PolarView(p: PolarViewProps) {
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);

  const origin = p.anchor ?? p.boat;
  const feet = p.units.distance === 'ft';

  // Metres shown from centre to edge of the view.
  const baseHalf = useMemo(() => {
    if (p.swingRadius !== null && p.swingRadius > 0) return p.swingRadius * 1.35;
    let maxD = 40;
    if (origin) {
      for (const t of p.track) {
        const xy = toLocalXY(origin, t);
        maxD = Math.max(maxD, Math.hypot(xy.x, xy.y) * 1.2);
      }
    }
    return maxD;
  }, [p.swingRadius, p.track, origin]);
  const half = baseHalf / zoom;
  const scale = HALF / half; // svg units per metre

  const toSvg = useCallback(
    (pos: LatLon): { x: number; y: number } | null => {
      if (!origin) return null;
      const xy = toLocalXY(origin, pos);
      return { x: HALF + xy.x * scale, y: HALF - xy.y * scale };
    },
    [origin, scale],
  );

  const ringM = niceRing(half, feet);
  const rings: number[] = [];
  for (let r = ringM; r < half * 1.42; r += ringM) rings.push(r);

  const boatSvg = p.boat ? toSvg(p.boat) : null;
  const setSvg = p.setPosition ? toSvg(p.setPosition) : null;
  const trackPath = useMemo(() => {
    if (!origin || p.track.length < 2) return '';
    return p.track
      .map((t, i) => {
        const s = toSvg(t);
        return s ? `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)} ${s.y.toFixed(1)}` : '';
      })
      .join(' ');
  }, [origin, p.track, toSvg]);

  const anchorSvg = p.anchor ? toSvg(p.anchor) : null;
  const anchorDraw = dragging ?? anchorSvg;

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
    if (!p.nudgeMode || !anchorSvg) return;
    const pt = svgPoint(e);
    if (!pt) return;
    if (Math.hypot(pt.x - anchorSvg.x, pt.y - anchorSvg.y) < 40) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(pt);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    const pt = svgPoint(e);
    if (pt) setDragging(pt);
  };
  const onPointerUp = () => {
    if (!dragging || !origin || !p.onNudge) {
      setDragging(null);
      return;
    }
    const xy = { x: (dragging.x - HALF) / scale, y: (HALF - dragging.y) / scale };
    p.onNudge(fromLocalXY(origin, xy));
    setDragging(null);
  };

  const fmtRing = (m: number) =>
    feet ? `${Math.round(metresToFeet(m))} ft` : `${Math.round(m)} m`;

  return (
    <div className="polar-wrap">
      <svg
        ref={svgRef}
        className="polar"
        data-state={p.state}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={
          p.anchor
            ? `Anchor view. Swing radius ${fmtRing(p.swingRadius ?? 0)}. Boat ${p.boat ? fmtRing(distance(p.anchor, p.boat)) : 'unknown'} from anchor.`
            : 'Position view, no anchor session.'
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragging(null)}
      >
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
          <path d={`M${HALF} 14 l6 16 h-12 z`} />
          <text x={HALF} y={44} textAnchor="middle">
            N
          </text>
        </g>

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

        {/* swing circle + warning ring */}
        {anchorDraw && p.swingRadius !== null ? (
          <>
            {p.warnRadius !== null && p.warnRadius > 0 ? (
              <circle
                className="warn-ring"
                cx={anchorDraw.x}
                cy={anchorDraw.y}
                r={p.warnRadius * scale}
              />
            ) : null}
            <circle
              className="swing"
              cx={anchorDraw.x}
              cy={anchorDraw.y}
              r={p.swingRadius * scale}
            />
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

        {/* AIS targets */}
        {p.showAis
          ? p.ais.map((t) => {
              if (t.lat === null || t.lon === null) return null;
              const s = toSvg({ lat: t.lat, lon: t.lon });
              if (!s || s.x < -20 || s.y < -20 || s.x > SIZE + 20 || s.y > SIZE + 20) return null;
              const rot = t.cog !== null ? radToDeg(t.cog) : 0;
              return (
                <g key={t.mmsi} transform={`translate(${s.x} ${s.y})`}>
                  <path className="ais" d="M0 -9 L6 7 L0 4 L-6 7 Z" transform={`rotate(${rot})`} />
                  <text className="ais-label" x={9} y={4}>
                    {t.name ?? t.mmsi}
                  </text>
                </g>
              );
            })
          : null}

        {/* anchor glyph */}
        {anchorDraw ? (
          <g className="anchor-g" transform={`translate(${anchorDraw.x} ${anchorDraw.y})`}>
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
          <g transform={`translate(${boatSvg.x} ${boatSvg.y})`}>
            {p.headingRad !== null ? (
              <g transform={`rotate(${radToDeg(p.headingRad)})`}>
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
        {p.positionStale ? <span>position stale</span> : null}
        {p.nudgeMode ? <span>drag the anchor</span> : null}
      </div>
      <div className="polar-controls">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(8, z * 1.5))}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.25, z / 1.5))}
        >
          −
        </button>
      </div>
    </div>
  );
}

function distance(a: LatLon, b: LatLon): number {
  const xy = toLocalXY(a, b);
  return Math.hypot(xy.x, xy.y);
}
