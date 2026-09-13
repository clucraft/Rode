import { z } from 'zod';
import { patchOf } from './patch.js';

/*
 * Request schemas for the REST API. The server validates every body with
 * these; the web app imports the inferred types.
 */

export const LatLonSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

// ---------------------------------------------------------------- anchor commands

export const DropRequest = z.object({
  /** Metres below the waterline, when the sounder is off. */
  manualDepth: z.number().min(0).max(200).optional(),
});
export type DropRequest = z.infer<typeof DropRequest>;

export const SetDepthRequest = z.object({ depth: z.number().min(0).max(200) });
export const NudgeRequest = z.object({ anchor: LatLonSchema });
export const SetTideRequest = z.object({ tideRange: z.number().min(0).max(20) });
/** Rode paid out, metres; null returns to the measured run. */
export const SetRodeRequest = z.object({ rodeLength: z.number().positive().max(500).nullable() });
export const WeighRequest = z.object({
  /** The UI sends true only after its confirmation prompt. The server refuses otherwise. */
  confirm: z.literal(true),
});
export const AckRequest = z.object({});
/** Manual circle. Metres; the engine validates the band and range. */
export const SetRadiusRequest = z.object({
  swingRadius: z.number().positive().optional(),
  warnRadius: z.number().min(0).optional(),
  mode: z.enum(['linked', 'independent']),
});
export type SetRadiusRequest = z.infer<typeof SetRadiusRequest>;

export const CommandResponse = z.object({
  ok: z.boolean(),
  /** Present when the engine rejected the command. */
  reason: z.string().optional(),
  message: z.string().optional(),
});
export type CommandResponse = z.infer<typeof CommandResponse>;

// ---------------------------------------------------------------- zones

export const ZoneInput = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['never-enter', 'must-stay-inside']),
  enabled: z.boolean().default(true),
  polygon: z.array(LatLonSchema).min(3).max(200),
});
export type ZoneInput = z.infer<typeof ZoneInput>;

export const ZoneRecord = ZoneInput.extend({
  id: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ZoneRecord = z.infer<typeof ZoneRecord>;

// ---------------------------------------------------------------- settings

export const BoatGeometrySchema = z.object({
  antennaToBowForward: z.number().min(-50).max(50),
  antennaToBowStarboard: z.number().min(-20).max(20),
  bowRollerHeight: z.number().min(0).max(10),
});

export const UnitsSchema = z.object({
  distance: z.enum(['m', 'ft']).default('m'),
  depth: z.enum(['m', 'ft', 'fathoms']).default('m'),
  speed: z.enum(['kn', 'm/s', 'km/h', 'mph']).default('kn'),
  temperature: z.enum(['C', 'F']).default('C'),
  /** Chain/rode length. Usually the same as distance, but many boats count chain in feet and distance in metres. */
  rode: z.enum(['m', 'ft']).default('m'),
});
export type Units = z.infer<typeof UnitsSchema>;

export const SourceSettingsSchema = z.object({
  kind: z.enum(['nmea0183-tcp', 'nmea0183-udp', 'signalk-ws', 'simulator', 'replay']),
  host: z.string().max(253).default('192.168.1.100'),
  port: z.number().int().min(1).max(65535).default(39150),
  signalkUrl: z.string().max(500).default(''),
  signalkToken: z.string().max(500).default(''),
  simScenario: z.string().max(64).default('quiet-night'),
  simSpeed: z.number().min(0.1).max(3600).default(1),
  replayFile: z.string().max(500).default(''),
  /** Distance from transducer to waterline, metres. */
  transducerDepth: z.number().min(0).max(5).default(0),
  /** Magnetic variation to use when the stream carries none, degrees east positive. */
  magneticVariationDeg: z.number().min(-60).max(60).nullable().default(null),
});
export type SourceSettings = z.infer<typeof SourceSettingsSchema>;

/**
 * Alarm thresholds arrive as a partial map of AlarmConfig keys to SI numbers.
 * Validation of ranges happens against ALARM_CONFIG_DOCS on the server.
 */
export const AlarmConfigPatch = z.record(z.string(), z.number());

export const SettingsView = z.object({
  boat: BoatGeometrySchema,
  units: UnitsSchema,
  source: SourceSettingsSchema,
  alarm: z.record(z.string(), z.number()),
  /** Target scope for the IDLE rode suggestion. */
  suggestedScope: z.number().min(2).max(10),
  /** Boat name shown in the UI and notifications. */
  boatName: z.string().max(60),
  /** IANA time zone for local-time features (heartbeat, solar window). */
  timeZone: z.string().max(60),
  nightMode: z.object({
    mode: z.enum(['auto', 'on', 'off']).default('auto'),
    /** Local HH:MM. */
    from: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default('20:00'),
    to: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default('06:00'),
  }),
});
export type SettingsView = z.infer<typeof SettingsView>;

export const SettingsPatch = z.object({
  boat: patchOf(BoatGeometrySchema).optional(),
  units: patchOf(UnitsSchema).optional(),
  source: patchOf(SourceSettingsSchema).optional(),
  alarm: z.record(z.string(), z.number()).optional(),
  suggestedScope: z.number().min(2).max(10).optional(),
  boatName: z.string().max(60).optional(),
  timeZone: z.string().max(60).optional(),
  nightMode: patchOf(SettingsView.shape.nightMode).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

// ---------------------------------------------------------------- history

export const HistoryQuery = z.object({
  /** ms epoch */
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

export const SessionSummary = z.object({
  id: z.string(),
  mode: z.enum(['anchor', 'marina']),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  geometry: z.record(z.string(), z.unknown()).nullable(),
  anchor: LatLonSchema.nullable(),
  depthAtDrop: z.number().nullable(),
  maxDistance: z.number().nullable(),
  warningCount: z.number(),
  alarmCount: z.number(),
  endedBy: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const TrackPoint = z.object({
  at: z.number(),
  lat: z.number(),
  lon: z.number(),
  sog: z.number().nullable(),
  heading: z.number().nullable(),
  distance: z.number().nullable(),
});
export type TrackPoint = z.infer<typeof TrackPoint>;

/** One point of an AIS target's recent track. */
export interface AisTrackPoint {
  at: number;
  lat: number;
  lon: number;
}

/** Bucketed samples for the Data screen's rolling charts. Angles are circular means. */
export interface SeriesBucket {
  at: number;
  sog: number | null;
  stw: number | null;
  aws: number | null;
  /** Apparent wind direction, radians true, from heading + AWA per sample. */
  awd: number | null;
  pressure: number | null;
  depth: number | null;
}

// ---------------------------------------------------------------- view preferences

/**
 * How the Watch and Traffic screens are shown. Stored on the server, not in
 * the browser, so a slider moved on the phone is what the laptop shows too.
 * Crew may change these; they carry no safety weight.
 */
export const ViewPrefs = z.object({
  /** Track tail on the Watch screen, hours. */
  trackHours: z.number().min(0.25).max(72).default(6),
  showAis: z.boolean().default(true),
  watchView: z.enum(['polar', 'chart']).default('polar'),
  /** Imagery source id drawn under the Watch view, or null for none. */
  imagerySource: z.string().max(40).nullable().default(null),
  /** Imagery under the Traffic view; the two screens are independent. */
  trafficImagery: z.string().max(40).nullable().default(null),
  /** Watch view half-width in metres; null follows the circle. */
  watchRange: z.number().min(10).max(200_000).nullable().default(null),
  /** Traffic view half-width in metres; null fits every target while trafficFitAll is on. */
  trafficRange: z.number().min(10).max(200_000).nullable().default(null),
  /** Keep the previous session's anchor visible, greyed, after weighing. */
  showPreviousAnchor: z.boolean().default(true),
  /** Traffic screen: fit every AIS target instead of the swing circle. */
  trafficFitAll: z.boolean().default(true),
  /** MMSIs whose hour of track is drawn on the Traffic view. */
  trackedAis: z.array(z.string().max(12)).max(50).default([]),
  /** Watch controls collapsed to a slim bar (per boat; the ack button never hides). */
  controlsCollapsed: z.boolean().default(false),
});
export type ViewPrefs = z.infer<typeof ViewPrefs>;
export const ViewPrefsPatch = patchOf(ViewPrefs);
export type ViewPrefsPatch = z.infer<typeof ViewPrefsPatch>;

// ---------------------------------------------------------------- imagery

export const MAX_IMAGERY_SOURCES = 5;

/**
 * A raster background for the polar view: either an MBTiles file on the box
 * or an online XYZ template that the server fetches and caches on disk.
 */
export const ImagerySourceInput = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['mbtiles', 'xyz']),
  /** mbtiles: path of the file, absolute or relative to the MBTiles directory. */
  path: z.string().max(400).optional(),
  /**
   * xyz: template with {z} {x} {y}, or {q} for a Bing quadkey; {s} picks a
   * subdomain from `subdomains`. Only http(s).
   */
  urlTemplate: z.string().max(600).optional(),
  subdomains: z.string().max(20).optional(),
  minZoom: z.number().int().min(0).max(22).default(0),
  maxZoom: z.number().int().min(0).max(22).default(19),
  attribution: z.string().max(200).optional(),
  enabled: z.boolean().default(true),
});
export type ImagerySourceInput = z.infer<typeof ImagerySourceInput>;

export const ImagerySource = ImagerySourceInput.extend({
  id: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ImagerySource = z.infer<typeof ImagerySource>;

/** What the server knows about a source right now; shown on the Imagery screen. */
export interface ImageryStatus {
  id: string;
  ok: boolean;
  message: string;
  /** mbtiles: from the file's metadata table. */
  format?: string;
  bounds?: [number, number, number, number];
  zoomRange?: [number, number];
  tileCount?: number;
  /** xyz: what is on disk. */
  cachedTiles?: number;
  cachedBytes?: number;
  /** Background download around the boat, if one is running or finished. */
  prefetch?: { running: boolean; done: number; total: number; failed: number; startedAt: number };
}

export const PrefetchRequest = z.object({
  /** Centre of the box to download. Defaults to the boat's position. */
  centre: LatLonSchema.optional(),
  /** Half-width of the box, metres. */
  radius: z.number().min(100).max(5000).default(1000),
  minZoom: z.number().int().min(0).max(22).default(14),
  maxZoom: z.number().int().min(0).max(22).default(19),
});
export type PrefetchRequest = z.infer<typeof PrefetchRequest>;

/** Named starting points for the Imagery screen's "add online source" menu. */
export const IMAGERY_PRESETS: readonly (ImagerySourceInput & { note: string })[] = [
  {
    name: 'Esri World Imagery',
    kind: 'xyz',
    urlTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    minZoom: 0,
    maxZoom: 19,
    attribution: 'Esri, Maxar, Earthstar Geographics',
    enabled: true,
    note: 'No key needed. Good coverage of coasts and anchorages.',
  },
  {
    name: 'Google Satellite',
    kind: 'xyz',
    urlTemplate: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    subdomains: '0123',
    minZoom: 0,
    maxZoom: 20,
    attribution: 'Google',
    enabled: true,
    note: 'Unofficial tile endpoint; subject to Google\u2019s terms.',
  },
  {
    name: 'Bing Aerial',
    kind: 'xyz',
    urlTemplate: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1',
    subdomains: '0123',
    minZoom: 1,
    maxZoom: 19,
    attribution: 'Microsoft',
    enabled: true,
    note: 'Quadkey tiles; subject to Microsoft\u2019s terms.',
  },
];
