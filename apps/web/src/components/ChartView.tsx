import { useEffect, useRef, useState } from 'react';
import { destination, type LatLon, type WatchStateName } from '@rode/core';
import type { AisTargetView, TrackPoint, ZoneRecord } from '@rode/protocol';
import type { Map as MlMap, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';

/*
 * MapLibre chart over local MBTiles (the `tiles` compose profile). Loaded
 * lazily so the default bundle stays small; the polar view remains the
 * primary display and the chart is an overlay of the same geometry on a
 * basemap. If the style cannot be fetched the caller falls back to the
 * polar view, and that is not an error state.
 */

export interface ChartViewProps {
  styleUrl: string;
  state: WatchStateName;
  anchor: LatLon | null;
  swingRadius: number | null;
  warnRadius: number | null;
  boat: LatLon | null;
  headingRad: number | null;
  track: TrackPoint[];
  zones: ZoneRecord[];
  ais: AisTargetView[];
  night: boolean;
  onUnavailable: (reason: string) => void;
}

function circlePolygon(centre: LatLon, radius: number, steps = 64): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const p = destination(centre, (2 * Math.PI * i) / steps, radius);
    ring.push([p.lon, p.lat]);
  }
  return ring;
}

/** Accept a MapLibre style, or a TileJSON (raster or vector) and wrap it in a minimal style. */
async function loadStyle(url: string): Promise<StyleSpecification> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`tiles: ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (Array.isArray(json.layers) && json.sources) return json as unknown as StyleSpecification;
  if (Array.isArray(json.tiles)) {
    const raster = typeof json.format === 'string' && json.format !== 'pbf';
    if (!raster) throw new Error('tiles: vector TileJSON needs a style.json');
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: json.tiles as string[],
          tileSize: (json.tileSize as number | undefined) ?? 256,
          minzoom: (json.minzoom as number | undefined) ?? 0,
          maxzoom: (json.maxzoom as number | undefined) ?? 18,
        },
      },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
  }
  throw new Error('tiles: unrecognised style');
}

export function ChartView(p: ChartViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const fitted = useRef(false);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    // Read through a function: the flag flips in cleanup while we await, which
    // TypeScript's narrowing cannot see.
    const isCancelled = () => cancelled;
    let map: MlMap | null = null;
    const container = el.current;
    void (async () => {
      try {
        const [maplibregl, style] = await Promise.all([
          import('maplibre-gl'),
          loadStyle(p.styleUrl),
        ]);
        if (isCancelled() || !container) return;
        const m = new maplibregl.Map({
          container,
          style,
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          center: [0, 0],
          zoom: 1,
        });
        map = m;
        m.touchZoomRotate.disableRotation();
        m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
        m.on('load', () => {
          if (isCancelled()) return;
          for (const id of ['zones', 'swing', 'warn', 'track', 'ais', 'anchor', 'boat']) {
            m.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          }
          m.addLayer({
            id: 'zones-fill',
            type: 'fill',
            source: 'zones',
            paint: {
              'fill-color': [
                'case',
                ['==', ['get', 'kind'], 'must-stay-inside'],
                '#1d7a4a',
                '#b8211a',
              ],
              'fill-opacity': 0.15,
            },
          });
          m.addLayer({
            id: 'zones-line',
            type: 'line',
            source: 'zones',
            paint: {
              'line-color': [
                'case',
                ['==', ['get', 'kind'], 'must-stay-inside'],
                '#1d7a4a',
                '#b8211a',
              ],
              'line-width': 2,
            },
          });
          m.addLayer({
            id: 'warn-line',
            type: 'line',
            source: 'warn',
            paint: { 'line-color': '#a8640e', 'line-width': 1.5, 'line-dasharray': [4, 3] },
          });
          m.addLayer({
            id: 'swing-line',
            type: 'line',
            source: 'swing',
            paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
          });
          m.addLayer({
            id: 'track-line',
            type: 'line',
            source: 'track',
            paint: { 'line-color': '#0d5fa4', 'line-width': 2, 'line-opacity': 0.8 },
          });
          m.addLayer({
            id: 'ais-pt',
            type: 'circle',
            source: 'ais',
            paint: {
              'circle-radius': 5,
              'circle-color': '#3b444d',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1,
            },
          });
          m.addLayer({
            id: 'ais-label',
            type: 'symbol',
            source: 'ais',
            layout: {
              'text-field': ['get', 'name'],
              'text-size': 11,
              'text-offset': [0.8, 0],
              'text-anchor': 'left',
            },
            paint: { 'text-color': '#3b444d', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
          });
          m.addLayer({
            id: 'anchor-pt',
            type: 'circle',
            source: 'anchor',
            paint: {
              'circle-radius': 6,
              'circle-color': '#101418',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          });
          m.addLayer({
            id: 'boat-pt',
            type: 'circle',
            source: 'boat',
            paint: {
              'circle-radius': 7,
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1.5,
            },
          });
          m.addLayer({
            id: 'boat-heading',
            type: 'line',
            source: 'boat',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
          });
          mapRef.current = m;
          setReady(true);
        });
        m.on('error', (e) => {
          // A missing tile is not fatal; a failed style is.
          if (!mapRef.current) p.onUnavailable(e.error.message);
        });
      } catch (err) {
        p.onUnavailable(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current = null;
      map?.remove();
    };
    // The style URL is the only thing that should recreate the map.
  }, [p.styleUrl]);

  // Push geometry on every change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (id: string, features: Feature[]) => {
      const src = map.getSource(id) as { setData: (d: FeatureCollection) => void } | undefined;
      src?.setData({ type: 'FeatureCollection', features });
    };
    const colour = p.state === 'ALARM' ? '#b8211a' : p.state === 'WARNING' ? '#a8640e' : '#101418';
    const boatColour = p.state === 'ALARM' ? '#b8211a' : '#0d5fa4';
    set(
      'zones',
      p.zones
        .filter((z) => z.enabled)
        .map((z) => ({
          type: 'Feature',
          properties: { kind: z.kind, name: z.name },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                ...z.polygon.map((q) => [q.lon, q.lat]),
                [z.polygon[0]?.lon ?? 0, z.polygon[0]?.lat ?? 0],
              ],
            ],
          },
        })),
    );
    set(
      'swing',
      p.anchor && p.swingRadius
        ? [
            {
              type: 'Feature',
              properties: { color: colour, width: p.state === 'ALARM' ? 4 : 2 },
              geometry: { type: 'LineString', coordinates: circlePolygon(p.anchor, p.swingRadius) },
            },
          ]
        : [],
    );
    set(
      'warn',
      p.anchor && p.warnRadius
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: circlePolygon(p.anchor, p.warnRadius) },
            },
          ]
        : [],
    );
    set(
      'track',
      p.track.length > 1
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: p.track.map((t) => [t.lon, t.lat]) },
            },
          ]
        : [],
    );
    set(
      'ais',
      p.ais
        .filter((t) => t.lat !== null && t.lon !== null)
        .map((t) => ({
          type: 'Feature',
          properties: { name: t.name ?? t.mmsi },
          geometry: { type: 'Point', coordinates: [t.lon ?? 0, t.lat ?? 0] },
        })),
    );
    set(
      'anchor',
      p.anchor
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: [p.anchor.lon, p.anchor.lat] },
            },
          ]
        : [],
    );
    const boatFeatures: Feature[] = [];
    if (p.boat) {
      boatFeatures.push({
        type: 'Feature',
        properties: { color: boatColour },
        geometry: { type: 'Point', coordinates: [p.boat.lon, p.boat.lat] },
      });
      if (p.headingRad !== null) {
        const tip = destination(p.boat, p.headingRad, Math.max(8, (p.swingRadius ?? 40) / 6));
        boatFeatures.push({
          type: 'Feature',
          properties: { color: boatColour },
          geometry: {
            type: 'LineString',
            coordinates: [
              [p.boat.lon, p.boat.lat],
              [tip.lon, tip.lat],
            ],
          },
        });
      }
    }
    set('boat', boatFeatures);
    if (!fitted.current) {
      const centre = p.anchor ?? p.boat;
      if (centre) {
        const r = (p.swingRadius ?? 60) * 1.6;
        const ne = destination(centre, Math.PI / 4, r * Math.SQRT2);
        const sw = destination(centre, (5 * Math.PI) / 4, r * Math.SQRT2);
        map.fitBounds(
          [
            [sw.lon, sw.lat],
            [ne.lon, ne.lat],
          ],
          { padding: 20, duration: 0 },
        );
        fitted.current = true;
      }
    }
  }, [
    ready,
    p.state,
    p.anchor,
    p.swingRadius,
    p.warnRadius,
    p.boat,
    p.headingRad,
    p.track,
    p.zones,
    p.ais,
  ]);

  return (
    <div
      ref={el}
      className={`chart ${p.night ? 'night' : ''}`}
      role="img"
      aria-label="Chart with anchor, swing circle and boat"
    />
  );
}
