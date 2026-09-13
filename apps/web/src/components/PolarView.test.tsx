import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { degToRad, destination } from '@rode/core';
import { PolarView } from './PolarView.jsx';
import { DEFAULT_UNITS } from '../lib/format.js';

const A = { lat: 32.29, lon: -64.83 };

describe('PolarView', () => {
  it('renders the swing circle, warning ring, boat and rings for an active session', () => {
    const boat = destination(A, degToRad(45), 30);
    const html = renderToString(
      <PolarView
        state="SET"
        anchor={A}
        swingRadius={48}
        warnRadius={38}
        boat={boat}
        headingRad={degToRad(225)}
        positionStale={false}
        track={[A, destination(A, 0, 10), boat]}
        zones={[
          {
            id: 'z',
            name: 'Reef',
            kind: 'never-enter',
            enabled: true,
            polygon: [
              destination(A, 0, 60),
              destination(A, degToRad(90), 60),
              destination(A, degToRad(180), 60),
            ],
            createdAt: 0,
            updatedAt: 0,
          },
        ]}
        ais={[
          {
            mmsi: '1',
            own: false,
            class: 'A',
            name: 'WANDERER',
            callsign: null,
            shipType: null,
            navStatus: 1,
            lat: destination(A, degToRad(90), 40).lat,
            lon: destination(A, degToRad(90), 40).lon,
            sog: 0,
            cog: 0,
            heading: null,
            length: null,
            beam: null,
            lastSeen: 0,
            lastPositionAt: 0,
            range: 40,
            bearing: 1.57,
            cpa: 40,
            tcpa: null,
          },
        ]}
        units={DEFAULT_UNITS}
        showAis
      />,
    );
    expect(html).toContain('class="swing"');
    expect(html).toContain('class="warn-ring"');
    expect(html).toContain('class="boat"');
    expect(html).toContain('class="track"');
    expect(html).toContain('Reef');
    expect(html).toContain('WANDERER');
    expect(html).toContain('data-state="SET"');
    expect(html).toMatch(/aria-label="Anchor view. Alarm radius 48 m. Boat 30 m from anchor."/);
    expect(html).toContain('alarm <!-- -->48.0 m');
    expect(html).toContain('warning <!-- -->38.0 m');
  });

  it('renders a position-only view with no session, in feet', () => {
    const html = renderToString(
      <PolarView
        state="IDLE"
        anchor={null}
        swingRadius={null}
        warnRadius={null}
        boat={A}
        headingRad={null}
        positionStale
        track={[]}
        zones={[]}
        ais={[]}
        units={{ ...DEFAULT_UNITS, distance: 'ft' }}
      />,
    );
    expect(html).not.toContain('class="swing"');
    expect(html).toContain('ft');
    expect(html).toContain('position stale');
  });
});

describe('PolarView additions', () => {
  const base = {
    state: 'SET' as const,
    anchor: A,
    swingRadius: 48,
    warnRadius: 38,
    boat: destination(A, degToRad(45), 30),
    positionStale: false,
    track: [],
    zones: [],
    ais: [],
    units: DEFAULT_UNITS,
  };

  it('draws the apparent wind arrow at heading + AWA and the readouts', () => {
    const html = renderToString(
      <PolarView
        {...base}
        headingRad={degToRad(90)}
        wind={{ awa: degToRad(30), aws: 6, stale: false }}
        depth={{ value: 5.2, stale: false }}
      />,
    );
    // Wind from 120° true: the arrow group is rotated by that much.
    expect(html).toMatch(/class="wind" transform="rotate\(120\.0 300 300\)"/);
    // The box shows the absolute direction (heading + AWA), not the angle off the bow.
    expect(html).toContain('wind <!-- -->120°');
    expect(html).toContain('11.7'); // 6 m/s in knots
    expect(html).toContain('depth');
    expect(html).toContain('5.2');
  });

  it('cannot place the arrow without a heading and says so', () => {
    const html = renderToString(
      <PolarView {...base} headingRad={null} wind={{ awa: 0.5, aws: 4, stale: false }} />,
    );
    expect(html).not.toContain('class="wind"');
    expect(html).toContain('no heading');
  });

  it('shows the previous anchor greyed and labels a manual circle', () => {
    const html = renderToString(
      <PolarView
        {...base}
        headingRad={null}
        manualRadius
        previousAnchor={{ anchor: destination(A, 0, 80), swingRadius: 40, endedAt: 1 }}
      />,
    );
    expect(html).toContain('previous anchor');
    expect(html).toContain('class="prev-swing"');
    expect(html).toContain('alarm <!-- -->48.0 m<!-- --> · manual');
  });

  it('lays imagery tiles across the whole square from the tile API', () => {
    const html = renderToString(
      <PolarView
        {...base}
        headingRad={null}
        imagery={{ id: 'sat', minZoom: 0, maxZoom: 19 }}
        pixelWidth={600}
      />,
    );
    expect(html).toContain('class="imagery-bg"');
    expect(html).not.toContain('clip-path');
    expect(html).toMatch(/href="\/api\/tiles\/sat\/1[6-9]\/\d+\/\d+"/);
    expect(html).toMatch(/imagery z<!-- -->1[6-9]/);
  });

  it('widens the view to fit AIS targets when asked', () => {
    const far = destination(A, degToRad(200), 900);
    const target = {
      mmsi: '2',
      own: false,
      class: 'B' as const,
      name: null,
      callsign: null,
      shipType: null,
      navStatus: null,
      lat: far.lat,
      lon: far.lon,
      sog: null,
      cog: null,
      heading: null,
      length: null,
      beam: null,
      lastSeen: 0,
      lastPositionAt: null,
      range: 900,
      bearing: 0,
      cpa: null,
      tcpa: null,
    };
    const tight = renderToString(<PolarView {...base} headingRad={null} ais={[target]} showAis />);
    const wide = renderToString(
      <PolarView {...base} headingRad={null} ais={[target]} showAis fitAis />,
    );
    expect(tight).not.toContain('>2<');
    expect(wide).toContain('>2<');
    expect(wide).toContain('rings <!-- -->500 m');
  });

  it('lets the page scroll unless a drag mode is on', () => {
    const plain = renderToString(<PolarView {...base} headingRad={null} />);
    expect(plain).toContain('touch-action:pan-y');
    const editing = renderToString(
      <PolarView
        {...base}
        headingRad={null}
        editRadius={{ onDrag: () => undefined, onCommit: () => undefined }}
      />,
    );
    expect(editing).toContain('touch-action:none');
    expect(editing).toContain('drag a ring to resize');
  });
});

describe('PolarView v0.3', () => {
  const base = {
    state: 'SET' as const,
    anchor: A,
    swingRadius: 48,
    warnRadius: 38,
    boat: destination(A, degToRad(45), 30),
    headingRad: null,
    positionStale: false,
    track: [],
    zones: [],
    ais: [],
    units: DEFAULT_UNITS,
  };
  const target = (mmsi: string, bearingDeg: number, m: number) => {
    const pos = destination(A, degToRad(bearingDeg), m);
    return {
      mmsi,
      own: false,
      class: 'A' as const,
      name: null,
      callsign: null,
      shipType: null,
      navStatus: null,
      lat: pos.lat,
      lon: pos.lon,
      sog: 2,
      cog: 0,
      heading: null,
      length: null,
      beam: null,
      lastSeen: 1000,
      lastPositionAt: 1000,
      range: m,
      bearing: degToRad(bearingDeg),
      cpa: m,
      tcpa: null,
    };
  };

  it('can hide the radius labels and draws AIS tracks in their own class', () => {
    const html = renderToString(
      <PolarView
        {...base}
        radiusLabels={false}
        showAis
        ais={[target('7', 90, 40)]}
        aisTracks={{
          '7': [
            destination(A, 0, 10),
            destination(A, degToRad(45), 20),
            destination(A, degToRad(90), 40),
          ],
        }}
      />,
    );
    expect(html).not.toContain('radius-label');
    expect(html).toContain('class="ais-track"');
    expect(html).toContain('class="ais-target"');
  });

  it('labels rings in nautical miles once they are a long way apart', () => {
    const html = renderToString(
      <PolarView {...base} range={20_000} onRangeChange={() => undefined} />,
    );
    expect(html).toContain('rings <!-- -->5 nm');
    const ft = renderToString(
      <PolarView
        {...base}
        units={{ ...DEFAULT_UNITS, distance: 'ft' }}
        range={1500}
        onRangeChange={() => undefined}
      />,
    );
    expect(ft).toContain('rings <!-- -->0.5 nm');
  });

  it('honours a supplied range and clamps it to 100 nm', () => {
    const a = renderToString(
      <PolarView {...base} range={1_000_000} onRangeChange={() => undefined} />,
    );
    expect(a).toContain('rings <!-- -->50 nm');
    const b = renderToString(<PolarView {...base} range={12} onRangeChange={() => undefined} />);
    expect(b).toContain('rings <!-- -->5 m');
  });
});
