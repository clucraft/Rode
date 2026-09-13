import { useEffect, useMemo, useRef, useState } from 'react';
import { effectiveRadii } from '@rode/core';
import type { AisTrackPoint } from '@rode/protocol';
import { api } from '../api/client.js';
import { usePrefs, useStore } from '../api/store.js';
import { useAuth } from '../api/auth.js';
import {
  DEFAULT_UNITS,
  fmtBearing,
  fmtDistance,
  fmtDuration,
  fmtRange,
  fmtSpeed,
} from '../lib/format.js';
import { useTheme } from '../lib/theme.js';
import { autoRange, PolarView } from '../components/PolarView.jsx';
import { ImageryPicker, useImagerySources } from '../components/ImageryPicker.jsx';

/*
 * AIS traffic for the anchored case: who is near, who is closing, and when.
 * Sorted by range; anything with a CPA inside the caution ring is flagged.
 * Targets the server has not heard for 30 minutes drop off the list and the
 * view, taking their track with them. "Track" per vessel draws its last
 * hour; the choice is a shared preference so every device shows the same.
 */

const CAUTION_CPA_M = 200;
const CAUTION_TCPA_S = 15 * 60;
const TRACK_MS = 60 * 60_000;

export function Traffic() {
  const { state, clockOffsetMs } = useStore();
  const { settings } = useAuth();
  const theme = useTheme();
  const [prefs, setPrefs] = usePrefs();
  const imagerySources = useImagerySources();
  const units = settings?.units ?? DEFAULT_UNITS;
  const now = Date.now() + clockOffsetMs;
  const targets = state?.ais ?? [];
  const boat = state?.watch.live.boat ?? state?.instruments.position?.value ?? null;
  const instruments = state?.instruments ?? {};
  const heading =
    instruments.heading && !instruments.heading.stale ? instruments.heading.value : null;
  const watch = state?.watch;
  const active = watch && watch.phase !== 'IDLE' ? watch.session : null;
  const radii = effectiveRadii(active);
  const origin = active?.anchor ?? boat;
  const closing = targets.filter(
    (t) =>
      t.cpa !== null &&
      t.tcpa !== null &&
      t.tcpa > 0 &&
      t.cpa < CAUTION_CPA_M &&
      t.tcpa < CAUTION_TCPA_S,
  );
  const imagery = useMemo(() => {
    const src = imagerySources.find((s) => s.id === prefs.trafficImagery && s.enabled);
    return src ? { id: src.id, minZoom: src.minZoom, maxZoom: src.maxZoom } : null;
  }, [imagerySources, prefs.trafficImagery]);

  // ---- tracks: fetch the hour once per tracked vessel, then follow live positions.
  const tracked = useMemo(() => new Set(prefs.trackedAis), [prefs.trackedAis]);
  const [tracks, setTracks] = useState<Record<string, AisTrackPoint[]>>({});
  const fetched = useRef(new Set<string>());
  useEffect(() => {
    for (const mmsi of tracked) {
      if (fetched.current.has(mmsi)) continue;
      fetched.current.add(mmsi);
      api
        .get<AisTrackPoint[]>(`/api/ais/${mmsi}/track`)
        .then((pts) => setTracks((t) => ({ ...t, [mmsi]: pts })))
        .catch(() => undefined);
    }
    // Untracked or vanished vessels lose their history here too.
    setTracks((t) => {
      const next: Record<string, AisTrackPoint[]> = {};
      let changed = false;
      for (const [mmsi, pts] of Object.entries(t)) {
        if (tracked.has(mmsi) && targets.some((x) => x.mmsi === mmsi)) next[mmsi] = pts;
        else changed = true;
      }
      for (const mmsi of Object.keys(t)) if (!(mmsi in next)) fetched.current.delete(mmsi);
      return changed ? next : t;
    });
  }, [tracked, targets]);
  useEffect(() => {
    // Append the live position of each tracked target as it moves; trim to an hour.
    setTracks((t) => {
      let changed = false;
      const next = { ...t };
      for (const target of targets) {
        if (!tracked.has(target.mmsi) || target.lat === null || target.lon === null) continue;
        const pts = next[target.mmsi] ?? [];
        const last = pts[pts.length - 1];
        if (
          last &&
          Math.abs(last.lat - target.lat) < 1e-7 &&
          Math.abs(last.lon - target.lon) < 1e-7
        )
          continue;
        const at = target.lastPositionAt ?? now;
        if (last && at - last.at < 10_000) continue;
        next[target.mmsi] = [...pts, { at, lat: target.lat, lon: target.lon }].filter(
          (q) => now - q.at <= TRACK_MS,
        );
        changed = true;
      }
      return changed ? next : t;
    });
  }, [targets, tracked, now]);
  const toggleTrack = (mmsi: string) => {
    const next = tracked.has(mmsi)
      ? prefs.trackedAis.filter((m) => m !== mmsi)
      : [...prefs.trackedAis, mmsi];
    setPrefs({ trackedAis: next });
  };

  // Fit-all follows the targets while it is on; turning it off freezes the
  // current extent so the picture does not jump. A manual zoom also turns it
  // off, so the extent only ever changes when the user asks.
  const currentAuto = autoRange({
    swingRadius: radii?.swingRadius ?? null,
    origin,
    track: [],
    fitAis: true,
    ais: targets,
  });
  const setFitAll = (on: boolean) => {
    if (on) setPrefs({ trafficFitAll: true, trafficRange: null });
    else setPrefs({ trafficFitAll: false, trafficRange: prefs.trafficRange ?? currentAuto });
  };

  return (
    <div className="stack">
      {closing.length > 0 ? (
        <div className="notice warn" role="alert">
          {closing.length === 1
            ? `${closing[0]?.name ?? closing[0]?.mmsi ?? ''} closes to ${fmtDistance(closing[0]?.cpa, units).value} ${fmtDistance(closing[0]?.cpa, units).unit} in ${fmtDuration((closing[0]?.tcpa ?? 0) * 1000)}.`
            : `${String(closing.length)} targets closing inside ${fmtDistance(CAUTION_CPA_M, units).value} ${fmtDistance(CAUTION_CPA_M, units).unit}.`}
        </div>
      ) : null}

      <PolarView
        state={watch?.stateName ?? 'IDLE'}
        anchor={active?.anchor ?? null}
        swingRadius={radii?.swingRadius ?? null}
        warnRadius={radii?.warnRadius ?? null}
        manualRadius={radii?.manual ?? false}
        radiusLabels={false}
        boat={boat}
        headingRad={heading}
        positionStale={false}
        track={[]}
        zones={[]}
        ais={targets}
        aisTracks={tracks}
        units={units}
        showAis
        fitAis={prefs.trafficFitAll}
        range={prefs.trafficFitAll ? null : prefs.trafficRange}
        onRangeChange={(m) => setPrefs({ trafficRange: m, trafficFitAll: false })}
        imagery={imagery}
        night={theme.theme === 'night'}
        now={now}
        wind={
          instruments.awa
            ? {
                awa: instruments.awa.value,
                aws: instruments.aws?.value ?? null,
                stale: instruments.awa.stale || (instruments.aws?.stale ?? true),
              }
            : undefined
        }
        depth={
          instruments.depth
            ? { value: instruments.depth.value, stale: instruments.depth.stale }
            : undefined
        }
      />

      <div className="track-range">
        <label className="checkbox small" style={{ minHeight: 0 }}>
          <input
            type="checkbox"
            checked={prefs.trafficFitAll}
            onChange={(e) => setFitAll(e.target.checked)}
          />{' '}
          Fit all targets
        </label>
        <ImageryPicker
          sources={imagerySources}
          value={prefs.trafficImagery}
          onChange={(id) => setPrefs({ trafficImagery: id })}
        />
        <span className="muted small">
          {targets.length === 0
            ? ''
            : `${String(targets.length)} target${targets.length === 1 ? '' : 's'} · gone after 30 min of silence`}
        </span>
      </div>

      {targets.length === 0 ? (
        <p className="muted">
          No AIS targets. Either nobody is about, or the AIS feed is not reaching Rode (check
          Diagnostics).
        </p>
      ) : null}

      <div className="scroll-x">
        <table className="table num">
          <thead>
            <tr>
              <th>Vessel</th>
              <th className="num">Range</th>
              <th className="num">Brg</th>
              <th className="num">SOG</th>
              <th className="num">COG</th>
              <th className="num">CPA</th>
              <th className="num">TCPA</th>
              <th>Seen</th>
              <th>Track</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => {
              const warn =
                t.cpa !== null &&
                t.tcpa !== null &&
                t.tcpa > 0 &&
                t.cpa < CAUTION_CPA_M &&
                t.tcpa < CAUTION_TCPA_S;
              const on = tracked.has(t.mmsi);
              return (
                <tr
                  key={t.mmsi}
                  style={warn ? { color: 'var(--warn)', fontWeight: 600 } : undefined}
                >
                  <td>
                    {t.name ?? t.mmsi}
                    <div className="small muted">
                      {t.mmsi} · class {t.class}
                      {t.navStatus === 1 ? ' · anchored' : t.navStatus === 5 ? ' · moored' : ''}
                    </div>
                  </td>
                  <td className="num">
                    {fmtRange(t.range, units).value} {fmtRange(t.range, units).unit}
                  </td>
                  <td className="num">{fmtBearing(t.bearing).value}</td>
                  <td className="num">{fmtSpeed(t.sog, units).value}</td>
                  <td className="num">{fmtBearing(t.cog).value}</td>
                  <td className="num">
                    {fmtRange(t.cpa, units).value} {fmtRange(t.cpa, units).unit}
                  </td>
                  <td className="num">
                    {t.tcpa === null ? '—' : t.tcpa <= 0 ? 'diverging' : fmtDuration(t.tcpa * 1000)}
                  </td>
                  <td>{fmtDuration(Math.max(0, now - t.lastSeen))}</td>
                  <td>
                    <button
                      type="button"
                      className={on ? 'btn small primary' : 'btn small'}
                      style={{ minHeight: 34 }}
                      aria-pressed={on}
                      onClick={() => toggleTrack(t.mmsi)}
                    >
                      {on ? 'Tracking' : 'Track'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
