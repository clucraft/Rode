import { z } from 'zod';
import { patchOf } from './patch.js';

/*
 * Notification configuration and delivery records.
 *
 * Multiple recipients, each with its own channels, each channel routed by
 * severity. Secrets are stored server-side; GET responses mask them and a
 * PUT that sends the mask back leaves the stored value alone.
 */

export const Severity = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof Severity>;

const severities = z.array(Severity).default(['warning', 'critical']);

export const NtfyTarget = z.object({
  kind: z.literal('ntfy'),
  enabled: z.boolean().default(true),
  severities,
  /** Full topic URL, e.g. https://ntfy.sh/rode-sabado-9f2 */
  url: z.url(),
  /** Optional access token (secret). */
  token: z.string().default(''),
});

export const PushoverTarget = z.object({
  kind: z.literal('pushover'),
  enabled: z.boolean().default(true),
  severities,
  /** Application token (secret). */
  token: z.string().min(1),
  /** User or group key (secret). */
  user: z.string().min(1),
});

export const TelegramTarget = z.object({
  kind: z.literal('telegram'),
  enabled: z.boolean().default(true),
  severities,
  /** Bot token (secret). */
  botToken: z.string().min(1),
  chatId: z.string().min(1),
});

export const WebhookTarget = z.object({
  kind: z.literal('webhook'),
  enabled: z.boolean().default(true),
  severities: z.array(Severity).default(['info', 'warning', 'critical']),
  url: z.url(),
  /** Extra headers, e.g. Authorization (values are secret). */
  headers: z.record(z.string(), z.string()).default({}),
});

export const MqttTarget = z.object({
  kind: z.literal('mqtt'),
  enabled: z.boolean().default(true),
  severities: z.array(Severity).default(['info', 'warning', 'critical']),
  /** mqtt://host:1883 or mqtts://… */
  url: z.string().min(1),
  username: z.string().default(''),
  /** secret */
  password: z.string().default(''),
  topicPrefix: z.string().default('rode'),
});

export const EmailTarget = z.object({
  kind: z.literal('email'),
  enabled: z.boolean().default(true),
  /** Email is for the daily heartbeat only by default. */
  severities: z.array(Severity).default(['info']),
  to: z.email(),
});

export const ChannelTarget = z.discriminatedUnion('kind', [
  NtfyTarget,
  PushoverTarget,
  TelegramTarget,
  WebhookTarget,
  MqttTarget,
  EmailTarget,
]);
export type ChannelTarget = z.infer<typeof ChannelTarget>;
export type ChannelKind = ChannelTarget['kind'];

export const Recipient = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  channels: z.array(ChannelTarget).default([]),
});
export type Recipient = z.infer<typeof Recipient>;

export const SmtpSettings = z.object({
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().default(''),
  /** secret */
  pass: z.string().default(''),
  from: z.string().default(''),
});

export const NotificationSettings = z.object({
  recipients: z.array(Recipient).default([]),
  heartbeat: z
    .object({
      enabled: z.boolean().default(true),
      /** Local HH:MM in the boat's time zone. */
      localTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('08:00'),
    })
    .default({ enabled: true, localTime: '08:00' }),
  smtp: SmtpSettings.default({ host: '', port: 587, secure: false, user: '', pass: '', from: '' }),
  /** Collapse identical warnings arriving within this window, ms. Criticals always send. */
  collapseWarningsMs: z.number().int().min(0).max(3_600_000).default(60_000),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const NotificationSettingsPatch = patchOf(NotificationSettings);
export type NotificationSettingsPatch = z.infer<typeof NotificationSettingsPatch>;

/** What a delivery attempt logs. */
export interface DeliveryRecord {
  at: number;
  recipientId: string;
  recipientName: string;
  channel: ChannelKind;
  severity: Severity;
  title: string;
  attempt: number;
  ok: boolean;
  status?: number | undefined;
  error?: string | undefined;
  durationMs: number;
}

export interface NotificationStats {
  /** Last successful delivery to any target. */
  lastConfirmedAt: number | null;
  /** Per target, keyed `${recipientId}:${channel}`. */
  targets: Record<
    string,
    {
      lastOkAt: number | null;
      lastFailAt: number | null;
      lastError: string | null;
      sent: number;
      failed: number;
    }
  >;
  /** Over the last 24 h. */
  sent24h: number;
  failed24h: number;
  queued: number;
}

export const TestRequest = z.object({
  recipientId: z.string().optional(),
  channel: z.string().optional(),
});
