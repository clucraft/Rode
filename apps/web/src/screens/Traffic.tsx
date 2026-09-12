import { useMemo } from 'react';
import { effectiveRadii } from '@rode/core';
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
import { PolarView } from '../components/PolarView.jsx';
import { ImageryPicker, useImagerySources } from '../components/ImageryPicker.jsx';

/*
 * AIS traffic for the anchored case: who is near, who is closing, and when.
 * Sorted by range; anything with a CPA inside the caution ring is flagged.
 * The view opens out far enough to show every target.
 */

const CAUTION_CPA_M = 200;
const CAUTION_TCPA_S = 15 * 60;

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
  const radii = effectiveRadii(active, {
    marinaRadius: settings?.alarm.marinaRadius ?? 30,
    warnDistance: settings?.alarm.warnDistance ?? 10,
  });
  const closing = targets.filter(
    (t) =>
      t.cpa !== null &&
      t.tcpa !== null &&
      t.tcpa > 0 &&
      t.cpa < CAUTION_CPA_M &&
      t.tcpa < CAUTION_TCPA_S,
  );
  const imagery = useMemo(() => {
    const src = imagerySources.find((s) => s.id === prefs.imagerySource && s.enabled);
    return src ? { id: src.id, minZoom: src.minZoom, maxZoom: src.maxZoom } : null;
  }, [imagerySources, prefs.imagerySource]);

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
        anchor={active?.anchor ?? active?.marinaCentre ?? null}
        swingRadius={radii?.swingRadius ?? null}
        warnRadius={radii?.warnRadius ?? null}
        manualRadius={radii?.manual ?? false}
        boat={boat}
        headingRad={heading}
        positionStale={false}
        track={[]}
        zones={[]}
        ais={targets}
        units={units}
        showAis
        fitAis={prefs.trafficFitAll}
        imagery={imagery}
        night={theme.theme === 'night'}
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
            onChange={(e) => setPrefs({ trafficFitAll: e.target.checked })}
          />{' '}
          Fit all targets
        </label>
        <ImageryPicker
          sources={imagerySources}
          value={prefs.imagerySource}
          onChange={(id) => setPrefs({ imagerySource: id })}
        />
        <span className="muted small">
          {targets.length === 0
            ? ''
            : `${String(targets.length)} target${targets.length === 1 ? '' : 's'}`}
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
                  <td>{fmtDuration(now - t.lastSeen)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
