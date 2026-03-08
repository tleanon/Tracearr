/**
 * Settings routes tests
 *
 * Tests the API endpoints for application settings:
 * - GET /settings - Get application settings (owner only)
 * - PATCH /settings - Update application settings (owner only)
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, Settings } from '@tracearr/shared';

// Mock the settings service
vi.mock('../../services/settings.js', () => ({
  getAllSettings: vi.fn(),
  setSettings: vi.fn(),
  getSettings: vi.fn(),
  getSetting: vi.fn(),
  getPollerSettings: vi.fn(),
  getGeoIPSettings: vi.fn(),
  getNetworkSettings: vi.fn(),
  getNotificationSettings: vi.fn(),
  getBackupScheduleSettings: vi.fn(),
}));

// Mock the database module (still needed for api-key and ip-warning routes)
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    selectDistinct: vi.fn(),
  },
}));

// Mock notification manager
vi.mock('../../services/notifications/index.js', () => ({
  notificationManager: {
    testAgent: vi.fn(),
  },
}));

// Mock geoip service
vi.mock('../../services/geoip.js', () => ({
  geoipService: {
    isPrivateIP: vi.fn(),
  },
}));

import { getAllSettings, setSettings } from '../../services/settings.js';
import { settingsRoutes } from '../settings.js';

const mockAllSettings: Settings = {
  allowGuestAccess: false,
  unitSystem: 'metric',
  discordWebhookUrl: 'https://discord.com/api/webhooks/123',
  customWebhookUrl: 'https://example.com/webhook',
  webhookFormat: 'json',
  ntfyTopic: null,
  ntfyAuthToken: null,
  pushoverUserKey: null,
  pushoverApiToken: null,
  pollerEnabled: true,
  pollerIntervalMs: 15000,
  usePlexGeoip: false,
  tautulliUrl: 'http://localhost:8181',
  tautulliApiKey: 'secret-api-key',
  externalUrl: 'https://tracearr.example.com',
  trustProxy: true,
  mobileEnabled: false,
  primaryAuthMethod: 'local',
  tailscaleEnabled: false,
  tailscaleHostname: null,
  backupScheduleType: 'disabled',
  backupScheduleTime: '02:00',
  backupScheduleDayOfWeek: 0,
  backupScheduleDayOfMonth: 1,
  backupRetentionCount: 7,
};

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });

  await app.register(settingsRoutes, { prefix: '/settings' });
  return app;
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'owner',
  serverIds: [],
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
  serverIds: [],
};

describe('Settings Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.mocked(getAllSettings).mockResolvedValue({ ...mockAllSettings });
    vi.mocked(setSettings).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /settings', () => {
    it('returns settings for owner', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.allowGuestAccess).toBe(false);
      expect(body.discordWebhookUrl).toBe('https://discord.com/api/webhooks/123');
      expect(body.pollerEnabled).toBe(true);
      expect(body.pollerIntervalMs).toBe(15000);
      expect(body.externalUrl).toBe('https://tracearr.example.com');
      expect(body.trustProxy).toBe(true);
    });

    it('returns tautulli API key to owners', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe('secret-api-key');
      expect(body.tautulliUrl).toBe('http://localhost:8181');
    });

    it('returns null for tautulliApiKey when not set', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        tautulliApiKey: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe(null);
    });

    it('rejects viewer accessing settings', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('returns webhook format settings', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        webhookFormat: 'ntfy',
        ntfyTopic: 'my-topic',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.webhookFormat).toBe('ntfy');
      expect(body.ntfyTopic).toBe('my-topic');
    });

    it('returns ntfy auth token to owners', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        ntfyAuthToken: 'tk_secret_token_456',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ntfyAuthToken).toBe('tk_secret_token_456');
    });

    it('returns null for ntfy auth token when not set', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ntfyAuthToken).toBe(null);
    });

    it('returns pushover api token to owners', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        pushoverApiToken: 'pushover-api-token',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pushoverApiToken).toBe('pushover-api-token');
    });

    it('returns null for pushover api token when not set', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pushoverApiToken).toBe(null);
    });
  });

  describe('PATCH /settings', () => {
    it('updates settings for owner', async () => {
      app = await buildTestApp(ownerUser);

      // After setSettings, getAllSettings returns updated values
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        allowGuestAccess: true,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { allowGuestAccess: true },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({ allowGuestAccess: true });
      const body = response.json();
      expect(body.allowGuestAccess).toBe(true);
    });

    it('updates webhook URLs', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        discordWebhookUrl: 'https://new-discord-webhook.com',
        customWebhookUrl: 'https://new-custom-webhook.com',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          discordWebhookUrl: 'https://new-discord-webhook.com',
          customWebhookUrl: 'https://new-custom-webhook.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.discordWebhookUrl).toBe('https://new-discord-webhook.com');
      expect(body.customWebhookUrl).toBe('https://new-custom-webhook.com');
    });

    it('updates poller settings', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        pollerEnabled: false,
        pollerIntervalMs: 30000,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { pollerEnabled: false, pollerIntervalMs: 30000 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pollerEnabled).toBe(false);
      expect(body.pollerIntervalMs).toBe(30000);
    });

    it('normalizes externalUrl by stripping trailing slash', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        externalUrl: 'https://new-url.com',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { externalUrl: 'https://new-url.com/' },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ externalUrl: 'https://new-url.com' })
      );
    });

    it('returns tautulli API key in PATCH response', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        tautulliApiKey: 'new-api-key',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { tautulliApiKey: 'new-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe('new-api-key');
    });

    it('rejects viewer updating settings', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { allowGuestAccess: true },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { pollerIntervalMs: 'not-a-number' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects invalid webhook format', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { webhookFormat: 'invalid-format' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('clears webhook URLs when set to null', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        discordWebhookUrl: null,
        customWebhookUrl: null,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { discordWebhookUrl: null, customWebhookUrl: null },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.discordWebhookUrl).toBe(null);
      expect(body.customWebhookUrl).toBe(null);
    });

    it('handles empty update body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
