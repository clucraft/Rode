import { useStore } from '../api/store.js';
import { useAuth } from '../api/auth.js';
import { DEFAULT_UNITS, fmtBearing, fmtDistance, fmtDuration, fmtSpeed } from '../lib/format.js';
import { PolarView } from '../components/PolarView.jsx';

/*
 * AIS traffic for the anchored case: who is near, who is closing, and when.
 * Sorted by range; anything with a CPA inside the caution ring is flagged.
 */

const CAUTION_CPA_M = 200;
const CAUTION_TCPA_S = 15 * 60;

export function Traffic() {
  const { state, clockOffsetMs } = useStore();
  const { settings } = useAuth();
  const units = settings?.units ?? DEFAULT_UNITS;
  const now = Date.now() + clockOffsetMs;
  const targets = state?.ais ?? [];
  const boat = state?.watch.live.boat ?? state?.instruments.position?.value ?? null;
  const heading =
    state?.instruments.heading && !state.instruments.heading.stale
      ? state.instruments.heading.value
      : null;
  const closing = targets.filter(
    (t) =>
      t.cpa !== null &&
      t.tcpa !== null &&
      t.tcpa > 0 &&
      t.cpa < CAUTION_CPA_M &&
      t.tcpa < CAUTION_TCPA_S,
  );

  return (
    <div className="stack">
      {closing.length > 0 ? (
        <div className="notice warn" role="alert">
          {closing.length === 1
            ? `${closing[0]?.name ?? closing[0]?.mmsi} closes to ${fmtDistance(closing[0]?.cpa, units).value} ${fmtDistance(closing[0]?.cpa, units).unit} in ${fmtDuration((closing[0]?.tcpa ?? 0) * 1000)}.`
            : `${closing.length} targets closing inside ${fmtDistance(CAUTION_CPA_M, units).value} ${fmtDistance(CAUTION_CPA_M, units).unit}.`}
        </div>
      ) : null}

      <PolarView
        state={state?.watch.stateName ?? 'IDLE'}
        anchor={state?.watch.session?.anchor ?? state?.watch.session?.marinaCentre ?? null}
        swingRadius={
          state?.watch.session?.geometry?.swingRadius ?? state?.watch.session?.marinaRadius ?? null
        }
        warnRadius={null}
        boat={boat}
        headingRad={heading}
        positionStale={false}
        track={[]}
        zones={[]}
        ais={targets}
        units={units}
        showAis
      />

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
                    {fmtDistance(t.range, units).value} {fmtDistance(t.range, units).unit}
                  </td>
                  <td className="num">{fmtBearing(t.bearing).value}</td>
                  <td className="num">{fmtSpeed(t.sog, units).value}</td>
                  <td className="num">{fmtBearing(t.cog).value}</td>
                  <td className="num">{fmtDistance(t.cpa, units).value}</td>
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
