-- Settings KV migration: convert from wide singleton table to key-value store
-- Safe order: create new → copy data → drop old → rename new

CREATE TABLE "settings_new" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settings_new_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL,
	"value" jsonb,
	CONSTRAINT "settings_new_name_unique" UNIQUE("name")
);
--> statement-breakpoint

-- Migrate existing settings from the old singleton row into KV pairs.
-- NULL columns are excluded (the service layer handles defaults for missing keys).
INSERT INTO "settings_new" ("name", "value")
SELECT name, value FROM (
  SELECT 'allowGuestAccess' AS name, to_jsonb(allow_guest_access) AS value FROM settings WHERE id = 1
  UNION ALL
  SELECT 'unitSystem', to_jsonb(unit_system) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'discordWebhookUrl', to_jsonb(discord_webhook_url) FROM settings WHERE id = 1 AND discord_webhook_url IS NOT NULL
  UNION ALL
  SELECT 'customWebhookUrl', to_jsonb(custom_webhook_url) FROM settings WHERE id = 1 AND custom_webhook_url IS NOT NULL
  UNION ALL
  SELECT 'webhookFormat', to_jsonb(webhook_format) FROM settings WHERE id = 1 AND webhook_format IS NOT NULL
  UNION ALL
  SELECT 'ntfyTopic', to_jsonb(ntfy_topic) FROM settings WHERE id = 1 AND ntfy_topic IS NOT NULL
  UNION ALL
  SELECT 'ntfyAuthToken', to_jsonb(ntfy_auth_token) FROM settings WHERE id = 1 AND ntfy_auth_token IS NOT NULL
  UNION ALL
  SELECT 'pushoverUserKey', to_jsonb(pushover_user_key) FROM settings WHERE id = 1 AND pushover_user_key IS NOT NULL
  UNION ALL
  SELECT 'pushoverApiToken', to_jsonb(pushover_api_token) FROM settings WHERE id = 1 AND pushover_api_token IS NOT NULL
  UNION ALL
  SELECT 'pollerEnabled', to_jsonb(poller_enabled) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'pollerIntervalMs', to_jsonb(poller_interval_ms) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'usePlexGeoip', to_jsonb(use_plex_geoip) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'tautulliUrl', to_jsonb(tautulli_url) FROM settings WHERE id = 1 AND tautulli_url IS NOT NULL
  UNION ALL
  SELECT 'tautulliApiKey', to_jsonb(tautulli_api_key) FROM settings WHERE id = 1 AND tautulli_api_key IS NOT NULL
  UNION ALL
  SELECT 'externalUrl', to_jsonb(external_url) FROM settings WHERE id = 1 AND external_url IS NOT NULL
  UNION ALL
  SELECT 'trustProxy', to_jsonb(trust_proxy) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'mobileEnabled', to_jsonb(mobile_enabled) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'primaryAuthMethod', to_jsonb(primary_auth_method) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'tailscaleEnabled', to_jsonb(tailscale_enabled) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'tailscaleState', to_jsonb(tailscale_state) FROM settings WHERE id = 1 AND tailscale_state IS NOT NULL
  UNION ALL
  SELECT 'tailscaleHostname', to_jsonb(tailscale_hostname) FROM settings WHERE id = 1 AND tailscale_hostname IS NOT NULL
  UNION ALL
  SELECT 'backupScheduleType', to_jsonb(backup_schedule_type) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'backupScheduleTime', to_jsonb(backup_schedule_time) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'backupScheduleDayOfWeek', to_jsonb(backup_schedule_day_of_week) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'backupScheduleDayOfMonth', to_jsonb(backup_schedule_day_of_month) FROM settings WHERE id = 1
  UNION ALL
  SELECT 'backupRetentionCount', to_jsonb(backup_retention_count) FROM settings WHERE id = 1
) AS migrated
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

DROP TABLE "settings" CASCADE;
--> statement-breakpoint

ALTER TABLE "settings_new" RENAME TO "settings";
--> statement-breakpoint
ALTER SEQUENCE "settings_new_id_seq" RENAME TO "settings_id_seq";
--> statement-breakpoint
ALTER TABLE "settings" RENAME CONSTRAINT "settings_new_name_unique" TO "settings_name_unique";
