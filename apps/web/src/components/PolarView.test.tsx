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
    expect(html).toMatch(/aria-label="Anchor view\. Swing radius 48 m\. Boat 30 m from anchor\."/);
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
