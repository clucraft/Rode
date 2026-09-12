import { useCallback, useEffect, useMemo, useState } from 'react';
import { effectiveRadii, type ActiveCondition, type LatLon, type WatchStateName } from '@rode/core';
import type { TrackPoint, Units, ZoneRecord } from '@rode/protocol';
import { Link } from 'react-router';
import { api, errorMessage } from '../api/client.js';
import { usePrefs, useStore } from '../api/store.js';
import { useAuth } from '../api/auth.js';
import { armAudio, disarmAudio, setAlarmLevel, useAudio } from '../lib/audio.js';
import {
  DEFAULT_UNITS,
  fmtBearing,
  fmtDepth,
  fmtDistance,
  fmtDuration,
  fmtPercent,
  fmtRelativeAngle,
  fmtRode,
  fmtScope,
  fmtSpeed,
  fmtTemp,
  fmtVoltage,
  fmtWatts,
  fromSiDistance,
  toSiDistance,
} from '../lib/format.js';
import { useWakeLock } from '../lib/wakelock.js';
import { ConfirmDialog, Dialog, Readout } from '../components/common.js';
import { PolarView } from '../components/PolarView.jsx';
import { ChartView } from '../components/ChartView.jsx';
import { ImageryPicker, useImagerySources } from '../components/ImageryPicker.jsx';
import { ZoneEditor } from './SettingsAdmin.jsx';
import { useTheme } from '../lib/theme.js';

/*
 * The Watch screen. Home when a session is active. Big unmissable banner,
 * the polar view, the distances that matter as the largest things on the
 * screen, and the controls in the lower third for wet hands.
 */

const STATE_LABEL: Record<WatchStateName, string> = {
  IDLE: 'Not watching',
  DROPPING: 'Anchor down',
  SET: 'Watching',
  MARINA: 'Marina watch',
  WARNING: 'Warning',
  ALARM: 'Alarm',
};

const CONDITION_LABEL: Record<string, string> = {
  'position-warning': 'Near the edge of the swing circle',
  'position-outside': 'Outside the swing circle',
  'wind-shift': 'Wind off the bow',
  speed: 'Moving',
  breakout: 'Break-out: moving with wind off the bow',
  'gps-stale': 'No GPS position',
  'source-disconnected': 'Data source disconnected',
  'depth-shallow': 'Shallow water',
  'zone-breach': 'In an exclusion zone',
  'zone-projected': 'Heading for an exclusion zone',
  'fridge-warm': 'Fridge warm',
  'fridge-failing': 'Fridge failing',
  'freezer-warm': 'Freezer warm',
  'freezer-failing': 'Freezer failing',
  'battery-low': 'Battery low',
  'solar-no-yield': 'No solar yield',
};

export function Watch() {
  const { state, link, clockOffsetMs } = useStore();
  const { settings, user, config } = useAuth();
  const theme = useTheme();
  const [prefs, setPrefs] = usePrefs();
  const viewMode = prefs.watchView;
  const showAis = prefs.showAis;
  const trackHours = prefs.trackHours;
  const [chartProblem, setChartProblem] = useState<string | null>(null);
  const chartAvailable = Boolean(config?.tilesUrl) && chartProblem === null;
  const audio = useAudio();
  const units = settings?.units ?? DEFAULT_UNITS;
  const [error, setError] = useState<string | null>(null);
  const [confirmWeigh, setConfirmWeigh] = useState(false);
  const [depthPrompt, setDepthPrompt] = useState(false);
  const [tidePrompt, setTidePrompt] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [editRadius, setEditRadius] = useState(false);
  const [zoneEditor, setZoneEditor] = useState(false);
  const [zones, setZones] = useState<ZoneRecord[]>([]);
  const [zonesTick, setZonesTick] = useState(0);
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const imagerySources = useImagerySources();

  const wakeLocked = useWakeLock(true);
  const watch = state?.watch ?? null;
  const stateName: WatchStateName = watch?.stateName ?? 'IDLE';
  const session = watch?.session ?? null;
  const geometry = session?.geometry ?? null;
  const instruments = state?.instruments ?? {};
  const serverNow = Date.now() + clockOffsetMs;
  const alarmCfg = {
    marinaRadius: settings?.alarm.marinaRadius ?? 30,
    warnDistance: settings?.alarm.warnDistance ?? 10,
  };

  // Alarm audio follows the server's state; snoozing silences it.
  useEffect(() => {
    if (!watch) return;
    const level = stateName === 'ALARM' ? 'critical' : stateName === 'WARNING' ? 'warning' : 'none';
    setAlarmLevel(level, watch.snoozed, watch.refires);
  }, [stateName, watch]);

  // Zones for the overlay.
  useEffect(() => {
    let cancelled = false;
    api
      .get<ZoneRecord[]>('/api/zones')
      .then((z) => {
        if (!cancelled) setZones(z);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session?.id, zonesTick]);

  // Track history: fetch on session/hours change, then append live positions.
  useEffect(() => {
    let cancelled = false;
    const from = Math.max(session?.startedAt ?? 0, serverNow - trackHours * 3_600_000);
    api
      .get<TrackPoint[]>(`/api/track?from=${from}&limit=5000`)
      .then((t) => {
        if (!cancelled) setTrack(t);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // serverNow intentionally excluded: refetch only when the window changes.
  }, [session?.id, trackHours]);
  const boat = watch?.live.boat ?? null;
  useEffect(() => {
    if (!boat) return;
    setTrack((t) => {
      const last = t[t.length - 1];
      if (last && Math.abs(last.lat - boat.lat) < 1e-7 && Math.abs(last.lon - boat.lon) < 1e-7)
        return t;
      const next = [
        ...t,
        { at: serverNow, lat: boat.lat, lon: boat.lon, sog: null, heading: null, distance: null },
      ];
      return next.length > 6000 ? next.slice(-6000) : next;
    });
  }, [boat?.lat, boat?.lon]);

  const command = useCallback(async (path: string, body?: unknown) => {
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; reason?: string; message?: string }>(path, body);
      if (!r.ok) {
        if (r.reason === 'depth-required') setDepthPrompt(true);
        else setError(r.message ?? 'That did not work.');
      }
      return r.ok;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  }, []);

  const onNudge = useCallback(
    (anchor: LatLon) => {
      void command('/api/anchor/nudge', { anchor });
    },
    [command],
  );

  const conditions = useMemo(
    () =>
      (watch?.conditions ?? [])
        .slice()
        .sort((a, b) =>
          a.severity === b.severity ? a.since - b.since : a.severity === 'critical' ? -1 : 1,
        ),
    [watch],
  );

  const phase = watch?.phase ?? 'IDLE';
  // An ended session stays on the state until the next drop: that is the
  // "previous anchor" shown greyed after weighing.
  const active = phase !== 'IDLE' ? session : null;
  const centre = active?.mode === 'marina' ? active.marinaCentre : (active?.anchor ?? null);
  const radii = effectiveRadii(active, alarmCfg);
  const radius = radii?.swingRadius ?? null;
  const warnRadius = radii?.warnRadius ?? null;
  const previousAnchor =
    prefs.showPreviousAnchor && phase === 'IDLE' && session?.anchor
      ? {
          anchor: session.anchor,
          swingRadius: session.radiusOverride?.swingRadius ?? session.geometry?.swingRadius ?? null,
          endedAt: session.endedAt,
        }
      : null;
  const hasFix = Boolean(boat) && (watch?.live.positionAgeS ?? 999) < 10;
  const positionStale = !hasFix;
  const canAct = user?.role === 'admin' || user?.role === 'crew';
  const isAdmin = user?.role === 'admin';
  const offline = link !== 'live';
  const imagery = useMemo(() => {
    const src = imagerySources.find((s) => s.id === prefs.imagerySource && s.enabled);
    return src ? { id: src.id, minZoom: src.minZoom, maxZoom: src.maxZoom } : null;
  }, [imagerySources, prefs.imagerySource]);
  const wind = instruments.awa
    ? {
        awa: instruments.awa.value,
        aws: instruments.aws?.value ?? null,
        stale: instruments.awa.stale || (instruments.aws?.stale ?? true),
      }
    : undefined;
  const depth = instruments.depth
    ? { value: instruments.depth.value, stale: instruments.depth.stale }
    : undefined;

  // Live preview while a ring is dragged; the server is the truth on release.
  const [radiusDraft, setRadiusDraft] = useState<{ swing: number; warn: number } | null>(null);
  const independent = session?.radiusOverride?.mode === 'independent';
  const [independentDraft, setIndependentDraft] = useState<boolean | null>(null);
  const independentMode = independentDraft ?? independent;
  const linkedPair = useCallback(
    (which: 'swing' | 'warn', metres: number): { swing: number; warn: number } => {
      if (independentMode) {
        return which === 'swing'
          ? { swing: metres, warn: Math.min(metres, warnRadius ?? 0) }
          : { swing: Math.max(metres, radius ?? 0), warn: metres };
      }
      const swing = which === 'swing' ? metres : metres + alarmCfg.warnDistance;
      return { swing, warn: Math.max(0, swing - alarmCfg.warnDistance) };
    },
    [independentMode, warnRadius, radius, alarmCfg.warnDistance],
  );
  const commitRadius = useCallback(
    async (which: 'swing' | 'warn', metres: number) => {
      setRadiusDraft(null);
      const body: Record<string, unknown> = { mode: independentMode ? 'independent' : 'linked' };
      body[which === 'swing' ? 'swingRadius' : 'warnRadius'] = metres;
      return command('/api/anchor/radius', body);
    },
    [independentMode, command],
  );

  const bannerDetail = (): string => {
    if (offline) return 'No connection to the boat. Showing the last known state.';
    if (!watch) return 'Waiting for the boat…';
    switch (stateName) {
      case 'IDLE':
        return hasFix ? 'Position good. Ready to drop.' : 'Waiting for a GPS fix.';
      case 'DROPPING':
        return session?.depthAtDrop === null
          ? 'Back down, then enter the depth and press Anchor set.'
          : 'Back down on the anchor, then press Anchor set.';
      case 'SET':
        return `Radius ${fmtDistance(radius, units).value} ${fmtDistance(radius, units).unit} · scope ${fmtScope(geometry?.scopeRatio).value}:1`;
      case 'MARINA':
        return `Radius ${fmtDistance(radius, units).value} ${fmtDistance(radius, units).unit} · wind detector off`;
      case 'WARNING':
      case 'ALARM': {
        const top = conditions[0];
        return top
          ? (CONDITION_LABEL[top.id] ?? top.id) + (watch.snoozed ? ' · sound snoozed' : '')
          : '';
      }
      default:
        return '';
    }
  };

  const since = (): string => {
    const c = conditions[0];
    if ((stateName === 'WARNING' || stateName === 'ALARM') && c)
      return `for ${fmtDuration(serverNow - c.since)}`;
    if (session && (stateName === 'SET' || stateName === 'MARINA'))
      return `for ${fmtDuration(serverNow - (session.setAt ?? session.startedAt))}`;
    return '';
  };

  return (
    <div className="watch">
      <section
        className="banner"
        data-state={offline ? 'IDLE' : stateName}
        data-snoozed={watch?.snoozed ? 'true' : 'false'}
        role="status"
        aria-live="assertive"
      >
        <StateGlyph state={offline ? 'IDLE' : stateName} />
        <div>
          <div className="state">{offline ? 'OFFLINE' : STATE_LABEL[stateName].toUpperCase()}</div>
          <div className="detail">{bannerDetail()}</div>
        </div>
        <div className="since num">{since()}</div>
      </section>

      {conditions.length > 0 ? (
        <ul className="conditions" aria-label="Active conditions">
          {conditions.map((c) => (
            <li key={c.key} className={c.severity}>
              <span className="cid">{CONDITION_LABEL[c.id] ?? c.id}</span>
              <span className="cvals num">{conditionValues(c, units)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {viewMode === 'chart' && chartAvailable && config?.tilesUrl ? (
        <ChartView
          styleUrl={config.tilesUrl}
          state={stateName}
          anchor={centre}
          swingRadius={radius}
          warnRadius={warnRadius}
          boat={boat}
          headingRad={
            instruments.heading && !instruments.heading.stale ? instruments.heading.value : null
          }
          track={track}
          zones={zones}
          ais={showAis ? (state?.ais ?? []) : []}
          night={theme.theme === 'night'}
          onUnavailable={(reason) => setChartProblem(reason)}
        />
      ) : (
        <PolarView
          state={stateName}
          anchor={centre}
          swingRadius={radiusDraft?.swing ?? radius}
          warnRadius={radiusDraft?.warn ?? warnRadius}
          manualRadius={radii?.manual ?? false}
          boat={boat}
          headingRad={
            instruments.heading && !instruments.heading.stale ? instruments.heading.value : null
          }
          positionStale={positionStale}
          track={track}
          zones={zones}
          ais={state?.ais ?? []}
          units={units}
          setPosition={active?.setPosition ?? null}
          nudgeMode={nudge && phase === 'SET'}
          onNudge={onNudge}
          showAis={showAis}
          wind={wind}
          depth={depth}
          previousAnchor={previousAnchor}
          imagery={imagery}
          night={theme.theme === 'night'}
          editRadius={
            editRadius && (phase === 'SET' || phase === 'MARINA')
              ? {
                  onDrag: (which, m) => setRadiusDraft(linkedPair(which, m)),
                  onCommit: (which, m) => void commitRadius(which, m),
                }
              : undefined
          }
        />
      )}

      <div className="track-range">
        <label htmlFor="track-hours">Track</label>
        <input
          id="track-hours"
          type="range"
          min={1}
          max={48}
          step={1}
          value={trackHours}
          onChange={(e) => setPrefs({ trackHours: Number(e.target.value) })}
          aria-valuetext={`${String(trackHours)} hours`}
        />
        <span className="num">{trackHours} h</span>
        <label className="checkbox small" style={{ minHeight: 0 }}>
          <input
            type="checkbox"
            checked={showAis}
            onChange={(e) => setPrefs({ showAis: e.target.checked })}
          />{' '}
          AIS
        </label>
        <ImageryPicker
          sources={imagerySources}
          value={prefs.imagerySource}
          onChange={(id) => setPrefs({ imagerySource: id })}
        />
        {config?.tilesUrl ? (
          <button
            type="button"
            className="btn quiet small"
            aria-pressed={viewMode === 'chart'}
            disabled={chartProblem !== null}
            title={chartProblem ? `Chart unavailable: ${chartProblem}` : undefined}
            onClick={() => setPrefs({ watchView: viewMode === 'chart' ? 'polar' : 'chart' })}
          >
            {viewMode === 'chart' && chartAvailable ? 'Polar view' : 'Chart'}
          </button>
        ) : null}
      </div>

      {editRadius && (phase === 'SET' || phase === 'MARINA') ? (
        <RadiusEditor
          units={units}
          swing={radiusDraft?.swing ?? radius}
          warn={radiusDraft?.warn ?? warnRadius}
          manual={radii?.manual ?? false}
          computed={active ? effectiveRadii({ ...active, radiusOverride: null }, alarmCfg) : null}
          independent={independentMode}
          warnDistance={alarmCfg.warnDistance}
          onIndependent={(v) => setIndependentDraft(v)}
          onApply={async (swing, warn) => {
            setRadiusDraft(null);
            return command('/api/anchor/radius', {
              swingRadius: swing,
              warnRadius: warn,
              mode: independentMode ? 'independent' : 'linked',
            });
          }}
          onReset={async () => {
            setRadiusDraft(null);
            setIndependentDraft(null);
            setError(null);
            try {
              await api.delete('/api/anchor/radius');
              return true;
            } catch (e) {
              setError(errorMessage(e));
              return false;
            }
          }}
          onClose={() => {
            setEditRadius(false);
            setRadiusDraft(null);
            setIndependentDraft(null);
          }}
        />
      ) : null}

      <section className="hero-row">
        {phase === 'IDLE' ? (
          <>
            <Readout
              hero
              label="Suggested rode"
              value={fmtRode(watch?.live.suggestedRode, units)}
              sub={`${settings?.suggestedScope ?? 5}:1 at current depth`}
              stale={!instruments.depth || instruments.depth.stale}
            />
            <Readout
              label="Depth"
              value={fmtDepth(instruments.depth?.value, units)}
              stale={instruments.depth?.stale ?? true}
            />
            <Readout
              label="SOG"
              value={fmtSpeed(instruments.sog?.value, units)}
              stale={instruments.sog?.stale ?? true}
            />
          </>
        ) : (
          <>
            <Readout
              hero
              label={session?.mode === 'marina' ? 'From marina position' : 'From anchor'}
              value={fmtDistance(watch?.live.distanceFromAnchor, units)}
              stale={positionStale}
              sub={`bearing ${fmtBearing(watch?.live.bearingFromAnchor).value}°`}
            />
            <Readout
              label="To edge"
              value={fmtDistance(watch?.live.distanceToEdge, units)}
              stale={positionStale}
            />
            <Readout
              label="Alarm radius"
              value={fmtDistance(radius, units)}
              sub={radii?.manual ? 'set by hand' : undefined}
            />
            <Readout
              label="Warning radius"
              value={fmtDistance(warnRadius, units)}
              sub={
                radii?.manual
                  ? session?.radiusOverride?.mode === 'independent'
                    ? 'independent'
                    : 'linked'
                  : `${fmtDistance(alarmCfg.warnDistance, units).value} ${fmtDistance(alarmCfg.warnDistance, units).unit} inside`
              }
            />
            {session?.mode === 'marina' ? (
              <>
                <Readout
                  label="House bank"
                  value={fmtPercent(instruments.batterySoc?.value)}
                  stale={instruments.batterySoc?.stale ?? true}
                  sub={
                    instruments.batteryVoltage
                      ? `${fmtVoltage(instruments.batteryVoltage.value).value} V`
                      : undefined
                  }
                />
                <Readout
                  label="Solar"
                  value={fmtWatts(instruments.solarPower?.value)}
                  stale={instruments.solarPower?.stale ?? true}
                />
                <Readout
                  label="Fridge"
                  value={fmtTemp(instruments.fridgeTemp?.value, units)}
                  stale={instruments.fridgeTemp?.stale ?? true}
                  sub={
                    watch?.marina.fridge.band === 'unknown' ? undefined : watch?.marina.fridge.band
                  }
                />
                <Readout
                  label="Freezer"
                  value={fmtTemp(instruments.freezerTemp?.value, units)}
                  stale={instruments.freezerTemp?.stale ?? true}
                  sub={
                    watch?.marina.freezer.band === 'unknown'
                      ? undefined
                      : watch?.marina.freezer.band
                  }
                />
              </>
            ) : null}
            {geometry ? (
              <>
                <Readout
                  label="Rode out"
                  value={fmtRode(geometry.rodeLength, units)}
                  sub={
                    geometry.tideRange > 0
                      ? `${fmtScope(geometry.scopeRatioAtHighWater).value}:1 at high water`
                      : undefined
                  }
                />
                <Readout label="Scope" value={fmtScope(geometry.scopeRatio)} />
                <Readout
                  label="Depth at drop"
                  value={fmtDepth(geometry.depthAtDrop, units)}
                  sub={session?.depthSource === 'manual' ? 'entered by hand' : 'from sounder'}
                />
              </>
            ) : null}
          </>
        )}
        <Readout
          label="Position age"
          value={{
            value: String(watch?.live.positionAgeS ?? '—'),
            unit: 's',
            label: `${watch?.live.positionAgeS ?? 'unknown'} seconds`,
          }}
          stale={positionStale}
        />
        <Readout
          label="Wind"
          value={fmtRelativeAngle(instruments.awa?.value)}
          sub={
            instruments.aws
              ? `${fmtSpeed(instruments.aws.value, units).value} ${fmtSpeed(instruments.aws.value, units).unit} apparent`
              : undefined
          }
          stale={instruments.awa?.stale ?? true}
        />
      </section>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="controls" aria-label="Anchor controls">
        <div className="audio-arm">
          <span aria-live="polite">
            Alarm sound on this device:{' '}
            <span className={`state ${audio.armed ? 'on' : 'off'}`}>
              {audio.armed ? 'ON' : 'OFF'}
            </span>
          </span>
          {audio.armed ? (
            <button type="button" className="btn quiet" onClick={disarmAudio}>
              Turn off
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void armAudio()}>
              {audio.wasArmed ? 'Tap to re-arm' : 'Enable alarm sound'}
            </button>
          )}
          {wakeLocked ? <span className="muted small">· screen stays on</span> : null}
        </div>

        {phase === 'IDLE' ? (
          <div className="btn-row">
            <button
              type="button"
              className="btn big primary"
              disabled={!canAct || !hasFix || offline}
              onClick={() => void command('/api/anchor/drop')}
            >
              Drop anchor
            </button>
            <button
              type="button"
              className="btn big"
              disabled={!canAct || !hasFix || offline}
              onClick={() => void command('/api/anchor/marina')}
            >
              Marina watch
            </button>
          </div>
        ) : null}

        {phase === 'DROPPING' ? (
          <div className="btn-row">
            <button
              type="button"
              className="btn big primary"
              disabled={!canAct || !hasFix || offline}
              onClick={() => void command('/api/anchor/set')}
            >
              Anchor set
            </button>
            {session?.depthAtDrop === null ? (
              <button type="button" className="btn big" onClick={() => setDepthPrompt(true)}>
                Enter depth
              </button>
            ) : null}
            <button
              type="button"
              className="btn quiet"
              disabled={!canAct || offline}
              onClick={() => setConfirmWeigh(true)}
            >
              Cancel (weigh)
            </button>
          </div>
        ) : null}

        {phase === 'SET' || phase === 'MARINA' ? (
          <>
            {conditions.length > 0 ? (
              <button
                type="button"
                className="btn big danger ack"
                disabled={!canAct || offline || watch?.snoozed}
                onClick={() => void command('/api/anchor/ack')}
              >
                {watch?.snoozed
                  ? `Snoozed ${fmtDuration((watch.ack?.until ?? 0) - serverNow)}`
                  : 'Acknowledge — silence for a while'}
              </button>
            ) : null}
            <div className="btn-row">
              {phase === 'SET' ? (
                <>
                  <button
                    type="button"
                    className={`btn ${nudge ? 'primary' : ''}`}
                    disabled={!canAct}
                    onClick={() => setNudge((n) => !n)}
                    aria-pressed={nudge}
                  >
                    {nudge ? 'Done adjusting' : 'Adjust anchor'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canAct || offline}
                    onClick={() => setTidePrompt(true)}
                  >
                    Tide{' '}
                    {geometry && geometry.tideRange > 0
                      ? `${fmtDistance(geometry.tideRange, units).value} ${fmtDistance(geometry.tideRange, units).unit}`
                      : ''}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className={`btn ${editRadius ? 'primary' : ''}`}
                disabled={!canAct || offline}
                aria-pressed={editRadius}
                onClick={() => {
                  setEditRadius((e) => !e);
                  setNudge(false);
                }}
              >
                {editRadius ? 'Done editing radius' : 'Edit alarm radius'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!canAct || offline}
                onClick={() => setConfirmWeigh(true)}
              >
                {phase === 'MARINA' ? 'Stop marina watch' : 'Weigh anchor'}
              </button>
            </div>
          </>
        ) : null}

        <div className="btn-row zone-row">
          <button
            type="button"
            className="btn"
            disabled={!canAct || offline || !isAdmin}
            title={isAdmin ? undefined : 'Admins can add zones'}
            onClick={() => setZoneEditor(true)}
          >
            Add exclusion zone
          </button>
          <span className="small muted">
            {zones.filter((z) => z.enabled).length === 0
              ? 'No zones.'
              : `${String(zones.filter((z) => z.enabled).length)} active zone${zones.filter((z) => z.enabled).length === 1 ? '' : 's'}: ${zones
                  .filter((z) => z.enabled)
                  .map((z) => z.name)
                  .join(', ')}.`}{' '}
            <Link to="/settings/zones">Manage</Link>
          </span>
        </div>
      </section>

      {zoneEditor ? (
        <ZoneEditor
          zone={null}
          onClose={() => setZoneEditor(false)}
          onSaved={() => {
            setZoneEditor(false);
            setZonesTick((n) => n + 1);
          }}
        />
      ) : null}

      {confirmWeigh ? (
        <ConfirmDialog
          title={phase === 'MARINA' ? 'Stop the marina watch?' : 'Weigh anchor?'}
          danger
          body={<p>This ends the watch. Nothing will alarm until you drop again.</p>}
          confirmLabel={phase === 'MARINA' ? 'Stop watching' : 'Weigh anchor'}
          onConfirm={async () => {
            if (!(await command('/api/anchor/weigh', { confirm: true })))
              throw new Error('Could not end the session.');
          }}
          onClose={() => setConfirmWeigh(false)}
        />
      ) : null}

      {depthPrompt ? (
        <DepthDialog
          units={units}
          onClose={() => setDepthPrompt(false)}
          onSubmit={(depth) => command('/api/anchor/depth', { depth })}
        />
      ) : null}
      {tidePrompt ? (
        <TideDialog
          units={units}
          current={geometry?.tideRange ?? 0}
          onClose={() => setTidePrompt(false)}
          onSubmit={(tideRange) => command('/api/anchor/tide', { tideRange })}
        />
      ) : null}
    </div>
  );
}

function StateGlyph({ state }: { state: WatchStateName }) {
  // Shape carries the state, not only colour: circle idle, ring watching,
  // triangle warning, octagon alarm.
  switch (state) {
    case 'WARNING':
      return (
        <svg className="glyph" viewBox="0 0 36 36" aria-hidden="true">
          <path d="M18 4 L34 32 H2 Z" fill="none" stroke="currentColor" strokeWidth="3" />
          <line x1="18" y1="14" x2="18" y2="23" stroke="currentColor" strokeWidth="3" />
          <circle cx="18" cy="27.5" r="1.8" fill="currentColor" />
        </svg>
      );
    case 'ALARM':
      return (
        <svg className="glyph" viewBox="0 0 36 36" aria-hidden="true">
          <path d="M11 3 H25 L33 11 V25 L25 33 H11 L3 25 V11 Z" fill="currentColor" />
          <line x1="18" y1="10" x2="18" y2="21" stroke="var(--bg)" strokeWidth="3.5" />
          <circle cx="18" cy="26.5" r="2" fill="var(--bg)" />
        </svg>
      );
    case 'SET':
    case 'MARINA':
      return (
        <svg className="glyph" viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="3" />
          <circle cx="18" cy="18" r="3" fill="currentColor" />
        </svg>
      );
    case 'DROPPING':
      return (
        <svg className="glyph" viewBox="0 0 36 36" aria-hidden="true">
          <circle
            cx="18"
            cy="18"
            r="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeDasharray="6 5"
          />
          <line x1="18" y1="9" x2="18" y2="27" stroke="currentColor" strokeWidth="3" />
          <path d="M11 21 L18 28 L25 21" fill="none" stroke="currentColor" strokeWidth="3" />
        </svg>
      );
    default:
      return (
        <svg className="glyph" viewBox="0 0 36 36" aria-hidden="true">
          <circle
            cx="18"
            cy="18"
            r="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeDasharray="6 5"
          />
        </svg>
      );
  }
}

function conditionValues(c: ActiveCondition, units: Units): string {
  const v = c.values;
  const parts: string[] = [];
  if (typeof v.distance === 'number')
    parts.push(
      `${fmtDistance(v.distance, units).value} ${fmtDistance(v.distance, units).unit} from anchor`,
    );
  if (typeof v.sog === 'number')
    parts.push(`SOG ${fmtSpeed(v.sog, units).value} ${fmtSpeed(v.sog, units).unit}`);
  if (typeof v.ageS === 'number') parts.push(`${v.ageS} s without a fix`);
  if (typeof v.disconnectedS === 'number') parts.push(`${v.disconnectedS} s`);
  if (typeof v.depth === 'number')
    parts.push(`depth ${fmtDepth(v.depth, units).value} ${fmtDepth(v.depth, units).unit}`);
  if (typeof v.zone === 'string') parts.push(v.zone);
  if (typeof v.temp === 'number' && typeof v.band === 'string') parts.push(v.band);
  return parts.join(' · ');
}
function DepthDialog(p: {
  units: Units;
  onClose: () => void;
  onSubmit: (depthM: number) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const feet = p.units.depth === 'ft';
  return (
    <Dialog
      title="Depth at the anchor"
      onClose={p.onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              const n = Number(text);
              if (!Number.isFinite(n) || n < 0) {
                setErr('Enter the depth as a number.');
                return;
              }
              const m = feet ? n * 0.3048 : p.units.depth === 'fathoms' ? n * 1.8288 : n;
              if (await p.onSubmit(m)) p.onClose();
            }}
          >
            Use this depth
          </button>
        </>
      }
    >
      <p>
        The sounder had no reading when the anchor went down. Enter the depth below the waterline
        now; it is used for the whole session.
      </p>
      <div className="field">
        <label htmlFor="depth-in">Depth ({p.units.depth})</label>
        <input
          id="depth-in"
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </div>
      {err ? <p className="error">{err}</p> : null}
    </Dialog>
  );
}

function TideDialog(p: {
  units: Units;
  current: number;
  onClose: () => void;
  onSubmit: (tideRangeM: number) => Promise<boolean>;
}) {
  const feet = p.units.distance === 'ft';
  const [text, setText] = useState(
    String(feet ? Math.round((p.current / 0.3048) * 10) / 10 : Math.round(p.current * 10) / 10),
  );
  return (
    <Dialog
      title="Expected tide range"
      onClose={p.onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              const n = Number(text);
              if (!Number.isFinite(n) || n < 0) return;
              if (await p.onSubmit(feet ? n * 0.3048 : n)) p.onClose();
            }}
          >
            Apply
          </button>
        </>
      }
    >
      <p>
        How much the water will rise or fall during the stay. The circle widens for the low-water
        swing and the scope shown is for high water. Zero if unknown.
      </p>
      <div className="field">
        <label htmlFor="tide-in">Range ({feet ? 'ft' : 'm'})</label>
        <input
          id="tide-in"
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </div>
    </Dialog>
  );
}

/**
 * Manual circle. Two fields in display units, a checkbox that unlinks them,
 * and a way back to the computed circle. Dragging the rings on the view
 * writes into the same fields.
 */
function RadiusEditor(p: {
  units: Units;
  swing: number | null;
  warn: number | null;
  manual: boolean;
  computed: { swingRadius: number; warnRadius: number } | null;
  independent: boolean;
  warnDistance: number;
  onIndependent: (v: boolean) => void;
  onApply: (swingM: number, warnM: number) => Promise<boolean>;
  onReset: () => Promise<boolean>;
  onClose: () => void;
}) {
  const show = (m: number | null) =>
    m === null ? '' : String(Math.round(fromSiDistance(m, p.units) * 10) / 10);
  const [swingText, setSwingText] = useState(show(p.swing));
  const [warnText, setWarnText] = useState(show(p.warn));
  const [err, setErr] = useState<string | null>(null);
  // Follow the rings while they are dragged.
  useEffect(() => {
    setSwingText(show(p.swing));
    setWarnText(show(p.warn));
  }, [p.swing, p.warn, p.units]);
  const unit = p.units.distance;
  const parse = (t: string) => {
    const n = Number(t);
    return Number.isFinite(n) ? toSiDistance(n, p.units) : NaN;
  };
  const onSwing = (t: string) => {
    setSwingText(t);
    if (!p.independent) {
      const m = parse(t);
      if (Number.isFinite(m)) setWarnText(show(Math.max(0, m - p.warnDistance)));
    }
  };
  const onWarn = (t: string) => {
    setWarnText(t);
    if (!p.independent) {
      const m = parse(t);
      if (Number.isFinite(m)) setSwingText(show(m + p.warnDistance));
    }
  };
  return (
    <section className="radius-editor" aria-label="Edit alarm radius">
      <div className="row">
        <div className="field">
          <label htmlFor="r-swing">Alarm radius ({unit})</label>
          <input
            id="r-swing"
            type="number"
            inputMode="decimal"
            step="1"
            min="0"
            value={swingText}
            onChange={(e) => onSwing(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="r-warn">Warning radius ({unit})</label>
          <input
            id="r-warn"
            type="number"
            inputMode="decimal"
            step="1"
            min="0"
            value={warnText}
            onChange={(e) => onWarn(e.target.value)}
          />
        </div>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={p.independent}
          onChange={(e) => p.onIndependent(e.target.checked)}
        />{' '}
        Ignore configured radius scale
        <span className="small muted">
          {' '}
          — unchecked, the warning ring stays {fmtDistance(p.warnDistance, p.units).value}{' '}
          {fmtDistance(p.warnDistance, p.units).unit} inside the alarm ring (the Settings value) and
          either field moves the other; checked, each is set on its own.
        </span>
      </label>
      {err ? <p className="error">{err}</p> : null}
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          onClick={async () => {
            setErr(null);
            const s = parse(swingText);
            const w = parse(warnText);
            if (!Number.isFinite(s) || !Number.isFinite(w)) {
              setErr('Enter both radii as numbers.');
              return;
            }
            if (w > s) {
              setErr('The warning radius must be inside the alarm radius.');
              return;
            }
            await p.onApply(s, w);
          }}
        >
          Apply
        </button>
        {p.manual ? (
          <button type="button" className="btn" onClick={() => void p.onReset()}>
            Reset to computed
            {p.computed
              ? ` (${fmtDistance(p.computed.swingRadius, p.units).value} ${fmtDistance(p.computed.swingRadius, p.units).unit})`
              : ''}
          </button>
        ) : null}
        <button type="button" className="btn quiet" onClick={p.onClose}>
          Done
        </button>
      </div>
    </section>
  );
}
