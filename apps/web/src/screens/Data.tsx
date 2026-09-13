import { useEffect, useState } from 'react';
import { radToDeg } from '@rode/core';
import type { SeriesBucket } from '@rode/protocol';
import { api } from '../api/client.js';
import { useStore } from '../api/store.js';
import { useAuth } from '../api/auth.js';
import { Chart } from '../components/Chart.jsx';
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
  fromSiSpeed,
} from '../lib/format.js';

/*
 * Live instruments plus the last 24 hours. Renders only what the boat
 * actually reports; a missing sensor is simply absent, not a dash forever.
 * True wind and apparent wind direction are computed on the server when the
 * instruments do not send them, and say so.
 */

const REFRESH_MS = 5 * 60_000;

export function Data() {
  const { state, clockOffsetMs } = useStore();
  const { settings } = useAuth();
  const units = settings?.units ?? DEFAULT_UNITS;
  const i = state?.instruments ?? {};
  const now = Date.now() + clockOffsetMs;
  const age = (ts?: number) => (ts ? fmtDuration(now - ts) + ' ago' : undefined);
  const any = Object.keys(i).length > 0;
  const derived = (f?: { source: string }) => (f?.source === 'derived' ? 'computed' : undefined);

  const [buckets, setBuckets] = useState<SeriesBucket[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<SeriesBucket[]>('/api/series/buckets?hours=24&bucketS=300')
        .then((b) => {
          if (!cancelled) setBuckets(b);
        })
        .catch(() => undefined);
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const speedPick = (v: number | null) => (v === null ? null : fromSiSpeed(v, units));
  const speedFmt = (v: number) => `${v.toFixed(1)} ${fmtSpeed(1, units).unit}`;
  const tz = settings?.timeZone;

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
                {i.satellites ? ` · ${String(i.satellites.value)} sats` : ''}
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
          {i.stw ? (
            <Readout
              label="STW"
              value={fmtSpeed(i.stw.value, units)}
              stale={i.stw.stale}
              sub="through the water"
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

      {i.awa || i.aws || i.awd || i.twa || i.tws || i.twd ? (
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
            {i.awd ? (
              <Readout
                label="Apparent direction"
                value={fmtBearing(i.awd.value)}
                stale={i.awd.stale}
                sub={derived(i.awd)}
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
                sub={derived(i.twa)}
              />
            ) : null}
            {i.twd ? (
              <Readout
                label="True direction"
                value={fmtBearing(i.twd.value)}
                stale={i.twd.stale}
                sub={derived(i.twd)}
              />
            ) : null}
            {i.tws ? (
              <Readout
                label="True speed"
                value={fmtSpeed(i.tws.value, units)}
                stale={i.tws.stale}
                sub={derived(i.tws)}
              />
            ) : null}
          </div>
          {i.awd?.source === 'derived' || i.tws?.source === 'derived' ? (
            <p className="small muted">
              Computed from apparent wind, heading and speed over ground; with the boat stopped,
              true wind equals apparent.
            </p>
          ) : null}
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
              />
            ) : null}
            {i.freezerTemp ? (
              <Readout
                label="Freezer"
                value={fmtTemp(i.freezerTemp.value, units)}
                stale={i.freezerTemp.stale}
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
                  label: `${name} ${String(f.value)} ${f.unit}`,
                }}
                stale={f.stale}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="section">
        <h2>Last 24 hours</h2>
        <p className="small muted">
          Five-minute averages from the boat&apos;s own log; wind direction is a circular mean.
          {buckets.length === 0 ? ' Nothing recorded yet.' : ''}
        </p>
        <Chart
          title="Apparent wind speed"
          series={buckets}
          pick={(b) => speedPick(b.aws)}
          fmt={speedFmt}
          tz={tz}
          empty="No wind recorded yet."
        />
        <Chart
          title="Apparent wind direction"
          series={buckets}
          pick={(b) => (b.awd === null ? null : radToDeg(b.awd))}
          fmt={(v) => `${String(Math.round(v))}°`}
          tz={tz}
          dots
          range={[0, 360]}
          empty="Needs heading and wind angle."
        />
        <Chart
          title="Barometer"
          series={buckets}
          pick={(b) => (b.pressure === null ? null : b.pressure / 100)}
          fmt={(v) => `${v.toFixed(1)} hPa`}
          tz={tz}
          empty="No barometer on the bus."
        />
        <Chart
          title="Speed over ground"
          series={buckets}
          pick={(b) => speedPick(b.sog)}
          fmt={speedFmt}
          tz={tz}
          empty="No GPS speed recorded yet."
        />
        <Chart
          title="Speed through water"
          series={buckets}
          pick={(b) => speedPick(b.stw)}
          fmt={speedFmt}
          tz={tz}
          empty="No log (VHW) on the bus."
        />
      </section>
    </div>
  );
}
