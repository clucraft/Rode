import { describe, expect, it } from 'vitest';
import { SettingsPatch, ViewPrefsPatch } from './api.js';
import { NotificationSettingsPatch } from './notifications.js';

describe('patch schemas', () => {
  it('carry only the keys that were sent (zod 4 partial() would fill defaults)', () => {
    expect(ViewPrefsPatch.parse({ trackHours: 12 })).toEqual({ trackHours: 12 });
    expect(SettingsPatch.parse({ units: { distance: 'ft' } })).toEqual({
      units: { distance: 'ft' },
    });
    expect(SettingsPatch.parse({ nightMode: { mode: 'on' } })).toEqual({
      nightMode: { mode: 'on' },
    });
    expect(NotificationSettingsPatch.parse({ collapseWarningsMs: 5 })).toEqual({
      collapseWarningsMs: 5,
    });
  });

  it('still validates what is sent', () => {
    expect(ViewPrefsPatch.safeParse({ trackHours: 1000 }).success).toBe(false);
    expect(SettingsPatch.safeParse({ units: { distance: 'furlongs' } }).success).toBe(false);
  });
});
