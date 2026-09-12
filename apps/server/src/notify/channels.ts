import mqtt from 'mqtt';
import nodemailer from 'nodemailer';
import type { ChannelTarget, Severity } from '@rode/protocol';
import type { z } from 'zod';
import type { SmtpSettings } from '@rode/protocol';

/*
 * One sender per channel. Each returns a DeliveryResult; nothing here
 * retries or logs, the dispatcher does that. Criticals use each platform's
 * maximum priority and bypass Do Not Disturb where the platform allows.
 */

export interface Notification {
  title: string;
  body: string;
  severity: Severity;
  /** Emoji-ish tags for ntfy; ignored elsewhere. */
  tags?: string[];
  at: number;
  /** Structured payload for webhook/MQTT consumers. */
  data?: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number | undefined;
  error?: string | undefined;
  durationMs: number;
}

export type Fetch = typeof fetch;

const TIMEOUT_MS = 15_000;

async function timed(
  fn: () => Promise<Omit<DeliveryResult, 'durationMs'>>,
): Promise<DeliveryResult> {
  const t = Date.now();
  try {
    const r = await fn();
    return { ...r, durationMs: Date.now() - t };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t,
    };
  }
}

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

// ---------------------------------------------------------------- ntfy

export function sendNtfy(
  n: Notification,
  t: Extract<ChannelTarget, { kind: 'ntfy' }>,
  fetchFn: Fetch,
): Promise<DeliveryResult> {
  return timed(async () => {
    const headers: Record<string, string> = {
      Title: n.title,
      // 5 = max (iOS critical alert when the app is configured for it), 4 = high, 3 = default.
      Priority: n.severity === 'critical' ? '5' : n.severity === 'warning' ? '4' : '3',
      Tags: (
        n.tags ?? [
          n.severity === 'critical'
            ? 'rotating_light'
            : n.severity === 'warning'
              ? 'warning'
              : 'anchor',
        ]
      ).join(','),
    };
    if (t.token) headers.Authorization = `Bearer ${t.token}`;
    const res = await fetchFn(t.url, {
      method: 'POST',
      headers,
      body: n.body,
      signal: withTimeout(),
    });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `ntfy ${res.status}` };
  });
}

// ---------------------------------------------------------------- pushover

export function sendPushover(
  n: Notification,
  t: Extract<ChannelTarget, { kind: 'pushover' }>,
  fetchFn: Fetch,
): Promise<DeliveryResult> {
  return timed(async () => {
    const form = new URLSearchParams({
      token: t.token,
      user: t.user,
      title: n.title,
      message: n.body,
      // 2 = emergency: repeats until acknowledged and bypasses quiet hours.
      priority: n.severity === 'critical' ? '2' : n.severity === 'warning' ? '1' : '0',
      sound:
        n.severity === 'critical' ? 'siren' : n.severity === 'warning' ? 'tugboat' : 'pushover',
      timestamp: String(Math.floor(n.at / 1000)),
    });
    if (n.severity === 'critical') {
      form.set('retry', '60');
      form.set('expire', '3600');
    }
    const res = await fetchFn('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: form,
      signal: withTimeout(),
    });
    let error: string | undefined;
    if (!res.ok) {
      try {
        const j = (await res.json()) as { errors?: string[] };
        error = j.errors?.join('; ') ?? `pushover ${res.status}`;
      } catch {
        error = `pushover ${res.status}`;
      }
    }
    return { ok: res.ok, status: res.status, error };
  });
}

// ---------------------------------------------------------------- telegram

export function sendTelegram(
  n: Notification,
  t: Extract<ChannelTarget, { kind: 'telegram' }>,
  fetchFn: Fetch,
): Promise<DeliveryResult> {
  return timed(async () => {
    const prefix = n.severity === 'critical' ? '🚨 ' : n.severity === 'warning' ? '⚠️ ' : '⚓ ';
    const res = await fetchFn(`https://api.telegram.org/bot${t.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: t.chatId,
        text: `${prefix}${n.title}\n${n.body}`,
        disable_notification: n.severity === 'info',
      }),
      signal: withTimeout(),
    });
    let error: string | undefined;
    if (!res.ok) {
      try {
        const j = (await res.json()) as { description?: string };
        error = j.description ?? `telegram ${res.status}`;
      } catch {
        error = `telegram ${res.status}`;
      }
    }
    return { ok: res.ok, status: res.status, error };
  });
}

// ---------------------------------------------------------------- webhook

export function sendWebhook(
  n: Notification,
  t: Extract<ChannelTarget, { kind: 'webhook' }>,
  fetchFn: Fetch,
): Promise<DeliveryResult> {
  return timed(async () => {
    const res = await fetchFn(t.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...t.headers },
      body: JSON.stringify({
        source: 'rode',
        at: new Date(n.at).toISOString(),
        severity: n.severity,
        title: n.title,
        body: n.body,
        ...n.data,
      }),
      signal: withTimeout(),
    });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `webhook ${res.status}` };
  });
}

// ---------------------------------------------------------------- mqtt

/**
 * A short-lived connection per message keeps this simple and robust; the
 * broker is on the LAN and the message rate is tiny. The state publisher
 * (mqtt.ts) holds a long-lived connection for retained state.
 */
export function sendMqtt(
  n: Notification,
  t: Extract<ChannelTarget, { kind: 'mqtt' }>,
): Promise<DeliveryResult> {
  return timed(
    () =>
      new Promise((resolve) => {
        const client = mqtt.connect(t.url, {
          ...(t.username ? { username: t.username } : {}),
          ...(t.password ? { password: t.password } : {}),
          connectTimeout: TIMEOUT_MS,
          reconnectPeriod: 0,
        });
        const done = (r: Omit<DeliveryResult, 'durationMs'>) => {
          client.end(true);
          resolve(r);
        };
        const timer = setTimeout(() => done({ ok: false, error: 'mqtt timeout' }), TIMEOUT_MS);
        client.on('connect', () => {
          const topic = `${t.topicPrefix}/notify/${n.severity}`;
          client.publish(
            topic,
            JSON.stringify({
              at: n.at,
              severity: n.severity,
              title: n.title,
              body: n.body,
              ...n.data,
            }),
            { qos: 1 },
            (err) => {
              clearTimeout(timer);
              done(err ? { ok: false, error: err.message } : { ok: true });
            },
          );
        });
        client.on('error', (err) => {
          clearTimeout(timer);
          done({ ok: false, error: err.message });
        });
      }),
  );
}

// ---------------------------------------------------------------- email

export function sendEmail(
  n: Notification,
  t: Extract<ChannelTarget, { kind: 'email' }>,
  smtp: z.infer<typeof SmtpSettings>,
): Promise<DeliveryResult> {
  return timed(async () => {
    if (!smtp.host) return { ok: false, error: 'SMTP is not configured' };
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
      connectionTimeout: TIMEOUT_MS,
    });
    await transport.sendMail({
      from: smtp.from || smtp.user,
      to: t.to,
      subject: n.title,
      text: n.body,
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- dispatch by kind

export interface ChannelDeps {
  fetch: Fetch;
  smtp: z.infer<typeof SmtpSettings>;
}

export function sendTo(
  n: Notification,
  t: ChannelTarget,
  deps: ChannelDeps,
): Promise<DeliveryResult> {
  switch (t.kind) {
    case 'ntfy':
      return sendNtfy(n, t, deps.fetch);
    case 'pushover':
      return sendPushover(n, t, deps.fetch);
    case 'telegram':
      return sendTelegram(n, t, deps.fetch);
    case 'webhook':
      return sendWebhook(n, t, deps.fetch);
    case 'mqtt':
      return sendMqtt(n, t);
    case 'email':
      return sendEmail(n, t, deps.smtp);
  }
}

/** Keys of each target that must never leave the server unmasked. */
export const SECRET_KEYS: Record<ChannelTarget['kind'], string[]> = {
  ntfy: ['token'],
  pushover: ['token', 'user'],
  telegram: ['botToken'],
  webhook: [],
  mqtt: ['password'],
  email: [],
};
