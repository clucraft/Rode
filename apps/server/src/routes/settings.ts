import type { FastifyInstance } from 'fastify';
import {
  ALARM_CONFIG_DOCS,
  DEFAULT_ALARM_CONFIG,
  DEFAULT_MARINA_CONFIG,
  MARINA_CONFIG_DOCS,
} from '@rode/core';
import { SCENARIOS } from '@rode/ingest';
import { SettingsPatch } from '@rode/protocol';
import { actorName, parseBody, type AppContext } from '../context.js';
import { requireRole } from '../auth/guard.js';

/** Settings are admin-only to write; crew may read (units, thresholds). */
export function settingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/settings', { preHandler: requireRole('crew') }, () => ctx.settings.view());

  /** Deployment-level, read-only: things set in the environment, not by the owner. */
  app.get('/api/config', { preHandler: requireRole('crew') }, () => ({
    version: ctx.version,
    tilesUrl: ctx.config.RODE_TILES_URL ?? null,
  }));

  /** Threshold documentation: labels, units, why, min/max, defaults. */
  app.get('/api/settings/docs', { preHandler: requireRole('crew') }, () => ({
    alarm: ALARM_CONFIG_DOCS,
    alarmDefaults: DEFAULT_ALARM_CONFIG,
    marinaDefaults: DEFAULT_MARINA_CONFIG,
    marina: MARINA_CONFIG_DOCS,
    scenarios: SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description })),
  }));

  app.patch('/api/settings', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = parseBody(SettingsPatch, req, reply);
    if (!body) return;
    const changed = ctx.settings.patch(body);
    ctx.repos.events.append('settings-changed', { keys: changed, by: actorName(req) });
    if (changed.includes('source')) await ctx.ingest.apply(ctx.settings.source());
    return ctx.settings.view();
  });

  app.post('/api/settings/alarm/restore-defaults', { preHandler: requireRole('admin') }, (req) => {
    ctx.settings.restoreAlarmDefaults();
    ctx.repos.events.append('settings-changed', {
      keys: ['alarm', 'marina'],
      restored: true,
      by: actorName(req),
    });
    return ctx.settings.view();
  });

  /** "Reconnect now" on the diagnostics page. */
  app.post('/api/source/restart', { preHandler: requireRole('admin') }, async (req) => {
    ctx.repos.events.append('source-restarted', { by: actorName(req) });
    await ctx.ingest.restart();
    return ctx.ingest.view();
  });
}
