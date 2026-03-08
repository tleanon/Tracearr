/**
 * Notification agent system tests
 *
 * Tests the notification agent dispatch functionality:
 * - Discord webhook notifications
 * - Custom webhook notifications with different formats
 * - Ntfy authentication header handling
 * - Test webhook functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationManager } from '../notifications/index.js';
import type { ViolationWithDetails, Settings } from '@tracearr/shared';
import { createMockActiveSession } from '../../test/fixtures.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create a mock Response with required methods
const createMockResponse = (ok: boolean, body: string = '') => ({
  ok,
  status: ok ? 200 : 500,
  text: vi.fn().mockResolvedValue(body),
});

describe('NotificationManager', () => {
  let manager: NotificationManager;

  beforeEach(() => {
    manager = new NotificationManager();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const createMockSettings = (overrides: Partial<Settings> = {}): Settings => ({
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
    tautulliUrl: null,
    tautulliApiKey: null,
    externalUrl: null,
    trustProxy: false,
    mobileEnabled: false,
    primaryAuthMethod: 'local',
    usePlexGeoip: false,
    tailscaleEnabled: false,
    tailscaleHostname: null,
    ...overrides,
  });

  const createMockViolation = (): ViolationWithDetails => ({
    id: 'violation-123',
    ruleId: 'rule-456',
    serverUserId: 'user-789',
    sessionId: 'session-123',
    severity: 'warning',
    data: { reason: 'test violation' },
    acknowledgedAt: null,
    createdAt: new Date(),
    user: {
      id: 'user-789',
      username: 'testuser',
      serverId: 'server-id',
      thumbUrl: null,
      identityName: 'Test User',
    },
    rule: {
      id: 'rule-456',
      name: 'Test Rule',
      type: 'concurrent_streams',
    },
  });

  describe('notifyViolation', () => {
    it('sends discord webhook for violations', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(true));

      const settings = createMockSettings({
        discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
      });

      await manager.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('sends custom webhook with ntfy format and auth token', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(true));

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'tracearr-alerts',
        ntfyAuthToken: 'tk_secret_token_123',
      });

      await manager.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com/',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_secret_token_123',
          },
        })
      );

      // Verify ntfy payload structure
      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.topic).toBe('tracearr-alerts');
      expect(body.title).toBe('Violation Detected');
      expect(body.priority).toBeGreaterThanOrEqual(1);
      expect(body.priority).toBeLessThanOrEqual(5);
    });

    it('sends custom webhook with ntfy format without auth token', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(true));

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'tracearr-alerts',
        ntfyAuthToken: null,
      });

      await manager.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com/',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        })
      );

      // Should NOT have Authorization header
      const callArgs = mockFetch.mock.calls[0]!;
      expect(callArgs[1].headers).not.toHaveProperty('Authorization');
    });

    it('sends custom webhook with apprise format (no auth)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(true));

      const settings = createMockSettings({
        customWebhookUrl: 'https://apprise.example.com/notify',
        webhookFormat: 'apprise',
      });

      await manager.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify apprise payload structure
      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.title).toBe('Violation Detected');
      expect(body.body).toContain('Test User'); // Uses identityName when available
      expect(body.type).toBe('warning');
    });

    it('sends custom webhook with pushover format', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(true));

      const settings = createMockSettings({
        webhookFormat: 'pushover',
        pushoverUserKey: 'pushover-user-key',
        pushoverApiToken: 'pushover-api-token',
      });

      await manager.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify pushover POST body
      const callArgs = mockFetch.mock.calls[0]!;
      expect(callArgs[0]).toBe('https://api.pushover.net/1/messages.json');
      const body = new URLSearchParams(callArgs[1].body);
      expect(body.get('user')).toBe('pushover-user-key');
      expect(body.get('token')).toBe('pushover-api-token');
      expect(body.get('title')).toBe('Violation Detected');
      expect(body.get('message')).toContain('Test User');
      expect(body.get('priority')).toBe('0');
    });

    it('sends custom webhook with json format', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(true));

      const settings = createMockSettings({
        customWebhookUrl: 'https://example.com/webhook',
        webhookFormat: 'json',
      });

      await manager.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify json payload structure
      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.event).toBe('violation_detected');
      expect(body.timestamp).toBeDefined();
      expect(body.data).toBeDefined();
    });

    it('sends to both discord and custom webhooks', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
        customWebhookUrl: 'https://example.com/webhook',
        webhookFormat: 'json',
      });

      await manager.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('notifyServerDown', () => {
    it('sends ntfy notification with auth token for server down', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'server-alerts',
        ntfyAuthToken: 'tk_server_token',
      });

      await manager.notifyServerDown('Plex Server', settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com/',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_server_token',
          },
        })
      );

      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.topic).toBe('server-alerts');
      expect(body.title).toBe('Server Offline');
      expect(body.message).toContain('Plex Server');
      expect(body.priority).toBe(5); // High priority for server down
    });

    it('sends pushover notification for server down', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        webhookFormat: 'pushover',
        pushoverUserKey: 'pushover-user-key',
        pushoverApiToken: 'pushover-api-token',
      });

      await manager.notifyServerDown('Plex Server', settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.pushover.net/1/messages.json',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      // Verify pushover POST body
      const callArgs = mockFetch.mock.calls[0]!;
      const body = new URLSearchParams(callArgs[1].body);
      expect(body.get('user')).toBe('pushover-user-key');
      expect(body.get('token')).toBe('pushover-api-token');
      expect(body.get('title')).toBe('Server Offline');
      expect(body.get('message')).toContain('Plex Server');
      expect(body.get('priority')).toBe('1'); // High priority for server down
    });
  });

  describe('notifyServerUp', () => {
    it('sends ntfy notification with auth token for server up', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'server-alerts',
        ntfyAuthToken: 'tk_server_token',
      });

      await manager.notifyServerUp('Plex Server', settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com/',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_server_token',
          },
        })
      );

      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.title).toBe('Server Online');
      expect(body.message).toContain('Plex Server');
    });

    it('sends pushover notification for server up', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        webhookFormat: 'pushover',
        pushoverUserKey: 'pushover-user-key',
        pushoverApiToken: 'pushover-api-token',
      });

      await manager.notifyServerUp('Plex Server', settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.pushover.net/1/messages.json',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      // Verify pushover POST body
      const callArgs = mockFetch.mock.calls[0]!;
      const body = new URLSearchParams(callArgs[1].body);
      expect(body.get('user')).toBe('pushover-user-key');
      expect(body.get('token')).toBe('pushover-api-token');
      expect(body.get('title')).toBe('Server Online');
      expect(body.get('message')).toContain('Plex Server');
      expect(body.get('priority')).toBe('1');
    });
  });

  describe('notifySessionStarted', () => {
    it('sends ntfy notification with auth for session start', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(true));

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'sessions',
        ntfyAuthToken: 'tk_session_token',
      });

      const session = createMockActiveSession({
        user: {
          id: 'user-789',
          username: 'testuser',
          thumbUrl: null,
          identityName: 'Test User',
        },
      });
      await manager.notifySessionStarted(session, settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com/',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_session_token',
          },
        })
      );

      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.title).toBe('Stream Started');
      expect(body.message).toContain('Test User');
      expect(body.message).toContain('Test Movie');
    });

    it('sends pushover notification for session start', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        webhookFormat: 'pushover',
        pushoverUserKey: 'pushover-user-key',
        pushoverApiToken: 'pushover-api-token',
      });

      await manager.notifySessionStarted(
        createMockActiveSession({
          user: {
            id: 'user-012',
            username: 'testuser',
            thumbUrl: null,
            identityName: 'Test User',
          },
        }),
        settings
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.pushover.net/1/messages.json',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      // Verify pushover POST body
      const callArgs = mockFetch.mock.calls[0]!;
      const body = new URLSearchParams(callArgs[1].body);
      expect(body.get('user')).toBe('pushover-user-key');
      expect(body.get('token')).toBe('pushover-api-token');
      expect(body.get('title')).toBe('Stream Started');
      expect(body.get('message')).toContain('Test User');
      expect(body.get('message')).toContain('Test Movie');
      expect(body.get('priority')).toBe('-1');
    });
  });
});

describe('testAgent', () => {
  let manager: NotificationManager;

  beforeEach(() => {
    manager = new NotificationManager();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends discord test webhook', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse(true));

    const result = await manager.testAgent('discord', {
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
      customWebhookUrl: null,
      webhookFormat: null,
      ntfyTopic: null,
      ntfyAuthToken: null,
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.username).toBe('Tracearr');
    expect(body.embeds[0].title).toBe('Test Notification');
  });

  it('sends ntfy test webhook with auth token', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse(true));

    const result = await manager.testAgent('ntfy', {
      discordWebhookUrl: null,
      customWebhookUrl: 'https://ntfy.example.com',
      webhookFormat: 'ntfy',
      ntfyTopic: 'tracearr-test',
      ntfyAuthToken: 'tk_test_token_123',
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ntfy.example.com/',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tk_test_token_123',
        },
      })
    );

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.topic).toBe('tracearr-test');
    expect(body.title).toBe('Test Notification');
    expect(body.tags).toContain('tracearr');
  });

  it('sends ntfy test webhook without auth token', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse(true));

    const result = await manager.testAgent('ntfy', {
      discordWebhookUrl: null,
      customWebhookUrl: 'https://ntfy.example.com',
      webhookFormat: 'ntfy',
      ntfyTopic: 'tracearr-test',
      ntfyAuthToken: null,
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ntfy.example.com/',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );

    // Should NOT have Authorization header
    const callArgs = mockFetch.mock.calls[0]!;
    expect(callArgs[1].headers).not.toHaveProperty('Authorization');
  });

  it('sends apprise test webhook', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse(true));

    const result = await manager.testAgent('apprise', {
      discordWebhookUrl: null,
      customWebhookUrl: 'https://apprise.example.com/notify',
      webhookFormat: 'apprise',
      ntfyTopic: null,
      ntfyAuthToken: null,
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(true);

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.title).toBe('Test Notification');
    expect(body.type).toBe('info');
  });

  it('sends json-webhook test', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse(true));

    const result = await manager.testAgent('json-webhook', {
      discordWebhookUrl: null,
      customWebhookUrl: 'https://example.com/webhook',
      webhookFormat: 'json',
      ntfyTopic: null,
      ntfyAuthToken: null,
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(true);

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.event).toBe('test');
    expect(body.data.message).toContain('test notification');
  });

  it('returns error when webhook fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await manager.testAgent('ntfy', {
      discordWebhookUrl: null,
      customWebhookUrl: 'https://ntfy.example.com',
      webhookFormat: 'ntfy',
      ntfyTopic: 'test',
      ntfyAuthToken: 'bad_token',
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns error when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await manager.testAgent('json-webhook', {
      discordWebhookUrl: null,
      customWebhookUrl: 'https://unreachable.example.com',
      webhookFormat: 'json',
      ntfyTopic: null,
      ntfyAuthToken: null,
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('returns error for unknown agent', async () => {
    const result = await manager.testAgent('unknown-agent', {
      discordWebhookUrl: null,
      customWebhookUrl: null,
      webhookFormat: null,
      ntfyTopic: null,
      ntfyAuthToken: null,
      pushoverUserKey: null,
      pushoverApiToken: null,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
