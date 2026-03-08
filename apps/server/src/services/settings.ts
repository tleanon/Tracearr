/**
 * Settings service - Key-value settings abstraction layer
 *
 * All settings access should go through this module instead of querying
 * the settings table directly.
 */

import { eq, inArray } from 'drizzle-orm';
import type { Settings, WebhookFormat, UnitSystem, BackupScheduleType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

/** Default values for public settings (returned by GET /settings). */
const PUBLIC_DEFAULTS: Settings = {
  // Settings interface fields
  allowGuestAccess: false,
  unitSystem: 'metric',
  discordWebhookUrl: null,
  customWebhookUrl: null,
  webhookFormat: null,
  ntfyTopic: null,
  ntfyAuthToken: null,
  pushoverUserKey: null,
  pushoverApiToken: null,
  pollerEnabled: true,
  pollerIntervalMs: 15000,
  usePlexGeoip: false,
  tautulliUrl: null,
  tautulliApiKey: null,
  externalUrl: null,
  trustProxy: false,
  mobileEnabled: false,
  primaryAuthMethod: 'local',
  tailscaleEnabled: false,
  tailscaleHostname: null,
  // Backup settings
  backupScheduleType: 'disabled',
  backupScheduleTime: '02:00',
  backupScheduleDayOfWeek: 0,
  backupScheduleDayOfMonth: 1,
  backupRetentionCount: 7,
};

/**
 * Internal-only settings — not exposed in the public Settings API.
 * Add new internal keys here; types, defaults, and filtering are all derived.
 */
const INTERNAL_DEFAULTS = {
  tailscaleState: null as string | null,
};

type InternalSettings = typeof INTERNAL_DEFAULTS;

/** All settings: public + internal */
type SettingTypes = Settings & InternalSettings;
type SettingKey = keyof SettingTypes;

/** Combined defaults — single source of truth. When a key doesn't exist in the DB, these defaults are used. */
const ALL_DEFAULTS: SettingTypes = { ...PUBLIC_DEFAULTS, ...INTERNAL_DEFAULTS };

/** Get a single setting value. Returns the stored value or the default. */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingTypes[K]> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.name, key))
    .limit(1);

  if (rows.length === 0) {
    return ALL_DEFAULTS[key];
  }

  return rows[0]!.value as SettingTypes[K];
}

/** Get multiple settings by keys. Returns a Record with defaults applied for missing keys. */
export async function getSettings<K extends SettingKey>(keys: K[]): Promise<Pick<SettingTypes, K>> {
  if (keys.length === 0) return {} as Pick<SettingTypes, K>;

  const rows = await db
    .select({ name: settings.name, value: settings.value })
    .from(settings)
    .where(inArray(settings.name, keys));

  const found = new Map(rows.map((r) => [r.name, r.value]));
  const result = {} as Record<K, unknown>;

  for (const key of keys) {
    result[key] = found.has(key) ? found.get(key) : ALL_DEFAULTS[key];
  }

  return result as Pick<SettingTypes, K>;
}

/** All keys that make up the public Settings object. */
const PUBLIC_KEYS = Object.keys(PUBLIC_DEFAULTS) as (keyof Settings)[];

/** Get ALL settings as a typed Settings object (used by GET /settings). */
export async function getAllSettings(): Promise<Settings> {
  return getSettings(PUBLIC_KEYS) as Promise<Settings>;
}

/** Upsert one or more settings. */
export async function setSettings(updates: Partial<SettingTypes>): Promise<void> {
  const entries = Object.entries(updates);
  if (entries.length === 0) return;

  await db.transaction(async (tx) => {
    for (const [name, value] of entries) {
      await tx.insert(settings).values({ name, value }).onConflictDoUpdate({
        target: settings.name,
        set: { value },
      });
    }
  });
}

/** Set a single setting. */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingTypes[K]
): Promise<void> {
  await db.insert(settings).values({ name: key, value }).onConflictDoUpdate({
    target: settings.name,
    set: { value },
  });
}

// ============================================================================
// Typed getter functions (used by internal consumers)
// ============================================================================

export async function getPollerSettings(): Promise<{
  enabled: boolean;
  intervalMs: number;
}> {
  const s = await getSettings(['pollerEnabled', 'pollerIntervalMs']);
  return {
    enabled: s.pollerEnabled,
    intervalMs: s.pollerIntervalMs,
  };
}

export async function getGeoIPSettings(): Promise<{ usePlexGeoip: boolean }> {
  return { usePlexGeoip: await getSetting('usePlexGeoip') };
}

export async function getNetworkSettings(): Promise<{
  externalUrl: string | null;
  trustProxy: boolean;
}> {
  const s = await getSettings(['externalUrl', 'trustProxy']);
  return {
    externalUrl: s.externalUrl,
    trustProxy: s.trustProxy,
  };
}

export interface NotificationSettings {
  discordWebhookUrl: string | null;
  customWebhookUrl: string | null;
  webhookFormat: WebhookFormat | null;
  ntfyTopic: string | null;
  ntfyAuthToken: string | null;
  pushoverUserKey: string | null;
  pushoverApiToken: string | null;
  webhookSecret: string | null;
  mobileEnabled: boolean;
  unitSystem: UnitSystem;
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const s = await getSettings([
    'discordWebhookUrl',
    'customWebhookUrl',
    'webhookFormat',
    'ntfyTopic',
    'ntfyAuthToken',
    'pushoverUserKey',
    'pushoverApiToken',
    'mobileEnabled',
    'unitSystem',
  ]);
  return {
    ...s,
    webhookSecret: null, // TODO: Phase 4
  };
}

export async function getBackupScheduleSettings(): Promise<{
  type: BackupScheduleType;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  retentionCount: number;
}> {
  const s = await getSettings([
    'backupScheduleType',
    'backupScheduleTime',
    'backupScheduleDayOfWeek',
    'backupScheduleDayOfMonth',
    'backupRetentionCount',
  ]);
  return {
    type: s.backupScheduleType,
    time: s.backupScheduleTime,
    dayOfWeek: s.backupScheduleDayOfWeek,
    dayOfMonth: s.backupScheduleDayOfMonth,
    retentionCount: s.backupRetentionCount,
  };
}
