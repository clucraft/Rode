import type { FastifyInstance } from 'fastify';
import { NotificationSettings, TestRequest } from '@rode/protocol';
import { actorName, parseBody, type AppContext } from '../context.js';
import { requireRole } from '../auth/guard.js';

/**
 * Notification settings (admin), a test button that reports per-target
 * results, delivery stats and the recent delivery log.
 */
export function notificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/notifications', { preHandler: requireRole('admin') }, () => ({
    settings: ctx.notify.dispatcher.maskedSettings(),
    stats: ctx.notify.dispatcher.getStats(),
    envRecipient: ctx.notify.envRecipient
      ? {
          name: ctx.notify.envRecipient.name,
          channels: ctx.notify.envRecipient.channels.map((c) => c.kind),
        }
      : null,
  }));

  app.put('/api/notifications', { preHandler: requireRole('admin') }, (req, reply) => {
    const body = parseBody(NotificationSettings, req, reply);
    if (!body) return;
    ctx.notify.dispatcher.updateSettings(body);
    ctx.repos.events.append('notifications-changed', {
      recipients: body.recipients.length,
      by: actorName(req),
    });
    return ctx.notify.dispatcher.maskedSettings();
  });

  app.post('/api/notifications/test', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = parseBody(TestRequest, req, reply);
    if (!body) return;
    const results = await ctx.notify.dispatcher.test(body.recipientId, body.channel);
    return { results };
  });

  app.post('/api/notifications/heartbeat', { preHandler: requireRole('admin') }, (req) => {
    ctx.repos.events.append('heartbeat-requested', { by: actorName(req) });
    ctx.notify.heartbeat.send();
    return { ok: true };
  });

  app.get('/api/notifications/deliveries', { preHandler: requireRole('crew') }, () =>
    ctx.notify.dispatcher.recentDeliveries(100),
  );
}
