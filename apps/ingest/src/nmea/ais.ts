import { AisDecode } from 'ggencoder';
import { degToRad, knotsToMps } from '@rode/core';

/**
 * AIS target tracking. Decoding is delegated to ggencoder (maintained; handles
 * multipart messages via the session object). This module only keeps the
 * latest picture per MMSI and converts to SI.
 */
export interface AisTarget {
  mmsi: string;
  /** True for our own vessel (VDO). */
  own: boolean;
  class: 'A' | 'B' | 'other';
  name: string | null;
  callsign: string | null;
  imo: number | null;
  shipType: number | null;
  navStatus: number | null;
  lat: number | null;
  lon: number | null;
  /** m/s */
  sog: number | null;
  /** radians true */
  cog: number | null;
  /** radians true */
  heading: number | null;
  /** deg/min, as reported */
  rateOfTurn: number | null;
  length: number | null;
  beam: number | null;
  draught: number | null;
  destination: string | null;
  /** Last time any message for this MMSI was received, ms epoch. */
  lastSeen: number;
  /** Last time a position report was received, ms epoch. */
  lastPositionAt: number | null;
}

export interface AisUpdate {
  target: AisTarget;
  /** True when this message carried a position. */
  position: boolean;
}

/** Message types that carry a position. */
const POSITION_TYPES = new Set([1, 2, 3, 4, 9, 18, 19, 21, 27]);
/** Message types that carry static data. */
const STATIC_TYPES = new Set([5, 24]);

export class AisTracker {
  private readonly targets = new Map<string, AisTarget>();
  /** ggencoder's multipart reassembly state. */
  private session: Record<string, unknown> = {};
  /** Decodes that produced neither a position nor static data. */
  public ignored = 0;

  /**
   * Feed one `!AIVDM`/`!AIVDO` sentence. Returns the updated target when a
   * complete message was decoded, otherwise null (partial or unsupported).
   */
  feed(rawSentence: string, own: boolean, now: number): AisUpdate | null {
    let d: AisDecode;
    try {
      d = new AisDecode(rawSentence, this.session);
    } catch {
      return null;
    }
    if (!d.valid) return null;

    const mmsi = String(d.mmsi);
    if (!/^\d{1,9}$/.test(mmsi)) return null;
    const isPos = POSITION_TYPES.has(d.aistype);
    const isStatic = STATIC_TYPES.has(d.aistype);
    if (!isPos && !isStatic) {
      this.ignored++;
      return null;
    }

    const existing = this.targets.get(mmsi);
    const t: AisTarget = existing ?? {
      mmsi,
      own,
      class: 'other',
      name: null,
      callsign: null,
      imo: null,
      shipType: null,
      navStatus: null,
      lat: null,
      lon: null,
      sog: null,
      cog: null,
      heading: null,
      rateOfTurn: null,
      length: null,
      beam: null,
      draught: null,
      destination: null,
      lastSeen: now,
      lastPositionAt: null,
    };
    t.lastSeen = now;
    if (own) t.own = true;
    if (d.class === 'A' || d.class === 'B') t.class = d.class;

    if (isPos) {
      if (isNum(d.lat) && isNum(d.lon) && Math.abs(d.lat) <= 90 && Math.abs(d.lon) <= 180) {
        t.lat = d.lat;
        t.lon = d.lon;
        t.lastPositionAt = now;
      }
      if (isNum(d.sog) && d.sog < 102.3) t.sog = knotsToMps(d.sog);
      if (isNum(d.cog) && d.cog < 360) t.cog = degToRad(d.cog);
      t.heading = isNum(d.hdg) && d.hdg !== 511 ? degToRad(d.hdg) : t.heading;
      if (isNum(d.rot) && d.rot !== -128) t.rateOfTurn = d.rot;
      if (isNum(d.navstatus)) t.navStatus = d.navstatus;
    }
    if (isStatic) {
      if (d.shipname) t.name = cleanText(d.shipname);
      if (d.callsign) t.callsign = cleanText(d.callsign);
      if (isNum(d.imo) && d.imo > 0) t.imo = d.imo;
      if (isNum(d.cargo)) t.shipType = d.cargo;
      if (isNum(d.length) && d.length > 0) t.length = d.length;
      if (isNum(d.width) && d.width > 0) t.beam = d.width;
      if (isNum(d.draught) && d.draught > 0) t.draught = d.draught;
      if (d.destination) t.destination = cleanText(d.destination);
    }

    this.targets.set(mmsi, t);
    return { target: t, position: isPos };
  }

  get(mmsi: string): AisTarget | undefined {
    return this.targets.get(mmsi);
  }

  all(): AisTarget[] {
    return [...this.targets.values()];
  }

  /** Drop targets not heard from within `maxAgeMs`. Returns the MMSIs removed. */
  prune(now: number, maxAgeMs: number): string[] {
    const removed: string[] = [];
    for (const [mmsi, t] of this.targets) {
      if (now - t.lastSeen > maxAgeMs) {
        this.targets.delete(mmsi);
        removed.push(mmsi);
      }
    }
    return removed;
  }

  reset(): void {
    this.targets.clear();
    this.session = {};
  }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** AIS text fields are padded with '@' and spaces. */
function cleanText(s: string): string | null {
  const t = s.replace(/@/g, '').trim();
  return t.length > 0 ? t : null;
}
