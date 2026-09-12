import { z } from 'zod';

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
export const WeighRequest = z.object({
  /** The UI sends true only after its confirmation prompt. The server refuses otherwise. */
  confirm: z.literal(true),
});
export const AckRequest = z.object({});

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
export const MarinaConfigPatch = z.record(z.string(), z.unknown());

export const SettingsView = z.object({
  boat: BoatGeometrySchema,
  units: UnitsSchema,
  source: SourceSettingsSchema,
  alarm: z.record(z.string(), z.number()),
  marina: z.record(z.string(), z.unknown()),
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
  boat: BoatGeometrySchema.partial().optional(),
  units: UnitsSchema.partial().optional(),
  source: SourceSettingsSchema.partial().optional(),
  alarm: z.record(z.string(), z.number()).optional(),
  marina: z.record(z.string(), z.unknown()).optional(),
  suggestedScope: z.number().min(2).max(10).optional(),
  boatName: z.string().max(60).optional(),
  timeZone: z.string().max(60).optional(),
  nightMode: SettingsView.shape.nightMode.partial().optional(),
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
