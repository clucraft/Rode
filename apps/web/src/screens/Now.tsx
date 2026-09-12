import { useStore } from '../api/store.js';
import { useAuth } from '../api/auth.js';
import { Readout } from '../components/common.js';
import {
  DEFAULT_UNITS,
  fmtBearing,
  fmtDepth,
  fmtDuration,
  fmtLatLon,
  fmtPercent,
  fmtPressure,
  fmtRelativeAngle,
  fmtSpeed,
  fmtTemp,
  fmtVoltage,
  fmtWatts,
} from '../lib/format.js';

/*
 * Live instruments. Renders only what the boat actually reports; a missing
 * sensor is simply absent, not a dash forever.
 */
export function Now() {
  const { state, clockOffsetMs } = useStore();
  const { settings } = useAuth();
  const units = settings?.units ?? DEFAULT_UNITS;
  const i = state?.instruments ?? {};
  const now = Date.now() + clockOffsetMs;
  const age = (ts?: number) => (ts ? fmtDuration(now - ts) + ' ago' : undefined);
  const any = Object.keys(i).length > 0;

  return (
    <div className="stack">
      {!any ? <p className="muted">No instruments yet. Waiting for data from the source.</p> : null}

      <section className="section">
        <h2>Navigation</h2>
        <div className="readouts">
          {i.position ? (
            <div className="readout num" style={{ gridColumn: '1 / -1' }}>
              <span className="label">Position</span>
              <span className="value" style={{ fontSize: '1.15rem' }}>
                {fmtLatLon(i.position.value)}
              </span>
              <span className="sub">
                {age(i.position.timestamp)}
                {i.hdop ? ` · HDOP ${i.hdop.value.toFixed(1)}` : ''}
                {i.satellites ? ` · ${i.satellites.value} sats` : ''}
              </span>
            </div>
          ) : null}
          {i.sog ? (
            <Readout
              label="SOG"
              value={fmtSpeed(i.sog.value, units)}
              stale={i.sog.stale}
              sub={age(i.sog.timestamp)}
            />
          ) : null}
          {i.cog ? (
            <Readout label="COG" value={fmtBearing(i.cog.value)} stale={i.cog.stale} />
          ) : null}
          {i.heading ? (
            <Readout label="Heading" value={fmtBearing(i.heading.value)} stale={i.heading.stale} />
          ) : null}
          {i.depth ? (
            <Readout
              label="Depth"
              value={fmtDepth(i.depth.value, units)}
              stale={i.depth.stale}
              sub={age(i.depth.timestamp)}
            />
          ) : null}
        </div>
      </section>

      {i.awa || i.aws || i.twa || i.tws || i.twd ? (
        <section className="section">
          <h2>Wind</h2>
          <div className="readouts">
            {i.awa ? (
              <Readout
                label="Apparent angle"
                value={fmtRelativeAngle(i.awa.value)}
                stale={i.awa.stale}
              />
            ) : null}
            {i.aws ? (
              <Readout
                label="Apparent speed"
                value={fmtSpeed(i.aws.value, units)}
                stale={i.aws.stale}
              />
            ) : null}
            {i.twa ? (
              <Readout
                label="True angle"
                value={fmtRelativeAngle(i.twa.value)}
                stale={i.twa.stale}
              />
            ) : null}
            {i.tws ? (
              <Readout
                label="True speed"
                value={fmtSpeed(i.tws.value, units)}
                stale={i.tws.stale}
              />
            ) : null}
            {i.twd ? (
              <Readout label="True direction" value={fmtBearing(i.twd.value)} stale={i.twd.stale} />
            ) : null}
          </div>
        </section>
      ) : null}

      {i.waterTemp || i.airTemp || i.pressure ? (
        <section className="section">
          <h2>Environment</h2>
          <div className="readouts">
            {i.waterTemp ? (
              <Readout
                label="Water"
                value={fmtTemp(i.waterTemp.value, units)}
                stale={i.waterTemp.stale}
              />
            ) : null}
            {i.airTemp ? (
              <Readout
                label="Air"
                value={fmtTemp(i.airTemp.value, units)}
                stale={i.airTemp.stale}
              />
            ) : null}
            {i.pressure ? (
              <Readout
                label="Pressure"
                value={fmtPressure(i.pressure.value)}
                stale={i.pressure.stale}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {i.batterySoc || i.batteryVoltage || i.solarPower || i.fridgeTemp || i.freezerTemp ? (
        <section className="section">
          <h2>Boat systems</h2>
          <div className="readouts">
            {i.batterySoc ? (
              <Readout
                label="House bank"
                value={fmtPercent(i.batterySoc.value)}
                stale={i.batterySoc.stale}
                sub={age(i.batterySoc.timestamp)}
              />
            ) : null}
            {i.batteryVoltage ? (
              <Readout
                label="House voltage"
                value={fmtVoltage(i.batteryVoltage.value)}
                stale={i.batteryVoltage.stale}
              />
            ) : null}
            {i.solarPower ? (
              <Readout
                label="Solar"
                value={fmtWatts(i.solarPower.value)}
                stale={i.solarPower.stale}
              />
            ) : null}
            {i.fridgeTemp ? (
              <Readout
                label="Fridge"
                value={fmtTemp(i.fridgeTemp.value, units)}
                stale={i.fridgeTemp.stale}
                sub={
                  state?.watch.marina.fridge.band !== 'unknown'
                    ? state?.watch.marina.fridge.band
                    : undefined
                }
              />
            ) : null}
            {i.freezerTemp ? (
              <Readout
                label="Freezer"
                value={fmtTemp(i.freezerTemp.value, units)}
                stale={i.freezerTemp.stale}
                sub={
                  state?.watch.marina.freezer.band !== 'unknown'
                    ? state?.watch.marina.freezer.band
                    : undefined
                }
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {i.extras && Object.keys(i.extras).length > 0 ? (
        <section className="section">
          <h2>Other transducers</h2>
          <div className="readouts">
            {Object.entries(i.extras).map(([name, f]) => (
              <Readout
                key={name}
                label={name}
                value={{
                  value: String(Math.round(f.value * 100) / 100),
                  unit: f.unit,
                  label: `${name} ${f.value} ${f.unit}`,
                }}
                stale={f.stale}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
