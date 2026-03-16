import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, ServerUser, Server, RuleV2 } from '@tracearr/shared';
import type { EvaluationContext } from '../types.js';
import {
  evaluateRule,
  evaluateRules,
  evaluateRuleAsync,
  evaluateRulesAsync,
  hasTranscodeConditions,
  hasPauseConditions,
} from '../engine.js';

// Mock geoipService
vi.mock('../../geoip.js', () => ({
  geoipService: {
    isPrivateIP: (ip: string) => {
      if (!ip) return false;
      return ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('127.');
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper to create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'user-1',
    sessionKey: 'sk-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rk-1',
    externalSessionId: 'ext-1',
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 0,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.100',
    geoCity: 'New York',
    geoRegion: 'NY',
    geoCountry: 'US',
    geoContinent: 'NA',
    geoPostal: '10001',
    geoLat: 40.7128,
    geoLon: -74.006,
    geoAsnNumber: 7922,
    geoAsnOrganization: 'Comcast',
    playerName: 'Player 1',
    deviceId: 'device-1',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Web',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 20000,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 1920,
    sourceVideoHeight: 1080,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  };
}

function createMockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  return {
    id: 'user-1',
    serverId: 'server-1',
    userId: 'identity-1',
    externalId: 'ext-user-1',
    username: 'testuser',
    email: 'test@example.com',
    thumbUrl: null,
    isServerAdmin: false,
    sessionCount: 10,
    joinedAt: new Date(),
    lastActivityAt: new Date(),
    trustScore: 100,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Test Server',
    type: 'plex',
    url: 'http://localhost:32400',
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    description: null,
    serverId: null,
    isActive: true,
    severity: 'warning',
    conditions: { groups: [] },
    actions: { actions: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createTestContext(
  rule: RuleV2,
  overrides: Partial<EvaluationContext> = {}
): EvaluationContext {
  const server = createMockServer();
  const serverUser = createMockServerUser({ serverId: server.id });
  const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

  return {
    session,
    serverUser,
    server,
    activeSessions: [session],
    recentSessions: [session],
    rule,
    ...overrides,
  };
}

describe('evaluateRule', () => {
  describe('empty conditions', () => {
    it('matches when rule has no conditions', () => {
      const rule = createMockRule({
        conditions: { groups: [] },
        actions: { actions: [{ type: 'log_only' }] },
      });
      const ctx = createTestContext(rule);

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([]);
      expect(result.actions).toEqual([{ type: 'log_only' }]);
      expect(result.evidence).toEqual([]);
    });

    it('does not match when conditions is null', () => {
      const rule = createMockRule({
        conditions: null as unknown as { groups: [] },
      });
      const ctx = createTestContext(rule);

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(false);
      expect(result.evidence).toBeUndefined();
    });
  });

  describe('single condition', () => {
    it('matches when condition is true', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [{ field: 'is_transcoding', operator: 'eq', value: false }],
            },
          ],
        },
        severity: 'warning',
        actions: { actions: [] },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ isTranscode: false }),
      });

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([0]);
    });

    it('does not match when condition is false', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }],
            },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ isTranscode: false }),
      });

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(false);
      expect(result.actions).toEqual([]);
    });
  });

  describe('OR logic within groups', () => {
    it('matches when any condition in a group is true', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '4K' },
                { field: 'source_resolution', operator: 'eq', value: '1080p' },
              ],
            },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(true);
    });

    it('does not match when all conditions in a group are false', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '4K' },
                { field: 'source_resolution', operator: 'eq', value: '720p' },
              ],
            },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(false);
    });
  });

  describe('AND logic between groups', () => {
    it('matches when all groups match', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
      });

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([0, 1]);
    });

    it('does not match when any group fails', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          sourceVideoWidth: 1920,
          sourceVideoHeight: 1080,
        }),
      });

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(false);
    });
  });

  describe('complex conditions', () => {
    it('evaluates (4K OR 1080p) AND transcoding AND low trust', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '4K' },
                { field: 'source_resolution', operator: 'eq', value: '1080p' },
              ],
            },
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            { conditions: [{ field: 'trust_score', operator: 'lt', value: 70 }] },
          ],
        },
        severity: 'high',
        actions: { actions: [] },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ trustScore: 50 }),
      });

      const result = evaluateRule(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([0, 1, 2]);
      expect(result.actions).toEqual([]);
    });

    it('user exclusion works (user NOT IN [excluded])', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            {
              conditions: [{ field: 'user_id', operator: 'not_in', value: ['admin-1', 'admin-2'] }],
            },
          ],
        },
      });

      // Regular user should match
      const regularCtx = createTestContext(rule, {
        session: createMockSession({ isTranscode: true }),
        serverUser: createMockServerUser({ id: 'regular-user' }),
      });

      expect(evaluateRule(regularCtx).matched).toBe(true);

      // Admin should not match
      const adminCtx = createTestContext(rule, {
        session: createMockSession({ isTranscode: true }),
        serverUser: createMockServerUser({ id: 'admin-1' }),
      });

      expect(evaluateRule(adminCtx).matched).toBe(false);
    });

    it('4K transcoding rule with user exclusion (issue #382 reproduction)', () => {
      const excludedUserId = 'owner-uuid-123';
      const rule = createMockRule({
        conditions: {
          groups: [
            // Group 1: is transcoding video
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: 'video' }] },
            // Group 2: source resolution is 4K
            { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
            // Group 3: user is NOT the excluded user
            {
              conditions: [{ field: 'user_id', operator: 'not_in', value: [excludedUserId] }],
            },
          ],
        },
        actions: {
          actions: [{ type: 'kill_stream', target: 'triggering', message: 'No 4K transcoding' }],
        },
      });

      // Non-excluded user transcoding 4K → should trigger
      const otherUserCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          videoDecision: 'transcode',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: 'other-user-456' }),
      });

      const otherResult = evaluateRule(otherUserCtx);
      expect(otherResult.matched).toBe(true);
      expect(otherResult.matchedGroups).toEqual([0, 1, 2]);

      // Verify evidence for matching rule shows all 3 groups matched
      expect(otherResult.evidence).toHaveLength(3);
      expect(otherResult.evidence![0]!.matched).toBe(true);
      expect(otherResult.evidence![1]!.matched).toBe(true);
      expect(otherResult.evidence![2]!.matched).toBe(true);

      // Excluded user transcoding 4K → should NOT trigger
      const excludedCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          videoDecision: 'transcode',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: excludedUserId }),
      });

      const excludedResult = evaluateRule(excludedCtx);
      expect(excludedResult.matched).toBe(false);
      // Evidence is only returned for matching rules (by design in evaluateRule)
      expect(excludedResult.evidence).toBeUndefined();

      // Excluded user NOT transcoding → should NOT trigger (group 1 fails)
      const excludedDirectPlayCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: false,
          videoDecision: 'directplay',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: excludedUserId }),
      });

      expect(evaluateRule(excludedDirectPlayCtx).matched).toBe(false);

      // Non-excluded user direct-playing 4K → should NOT trigger (group 1 fails)
      const otherDirectPlayCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: false,
          videoDecision: 'directplay',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: 'other-user-456' }),
      });

      expect(evaluateRule(otherDirectPlayCtx).matched).toBe(false);
    });

    it('not_in with non-array value falls back to neq (defensive)', () => {
      const excludedUserId = 'owner-uuid-123';
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                // Value stored as string instead of array (data corruption scenario)
                {
                  field: 'user_id',
                  operator: 'not_in',
                  value: excludedUserId as unknown as string[],
                },
              ],
            },
          ],
        },
      });

      // Excluded user → condition should NOT match (defensive fallback to neq)
      const excludedCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: excludedUserId }),
      });
      expect(evaluateRule(excludedCtx).matched).toBe(false);

      // Other user → condition SHOULD match
      const otherCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: 'other-user-456' }),
      });
      expect(evaluateRule(otherCtx).matched).toBe(true);
    });

    it('mobile bypass works (device NOT IN [mobile])', () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] },
            { conditions: [{ field: 'device_type', operator: 'not_in', value: ['mobile'] }] },
          ],
        },
      });

      // Desktop with 2 streams should match
      const desktopCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: 'user-1' }),
        session: createMockSession({ device: 'Chrome', platform: 'Windows', deviceId: 'device-1' }),
        activeSessions: [
          createMockSession({
            serverUserId: 'user-1',
            device: 'Chrome',
            platform: 'Windows',
            deviceId: 'device-1',
          }),
          createMockSession({
            serverUserId: 'user-1',
            device: 'Chrome',
            platform: 'Windows',
            deviceId: 'device-2',
          }),
        ],
      });

      expect(evaluateRule(desktopCtx).matched).toBe(true);

      // Mobile with 2 streams should not match (bypassed)
      const mobileCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: 'user-1' }),
        session: createMockSession({ device: 'iPhone', platform: 'iOS', deviceId: 'device-3' }),
        activeSessions: [
          createMockSession({
            serverUserId: 'user-1',
            device: 'iPhone',
            platform: 'iOS',
            deviceId: 'device-3',
          }),
          createMockSession({
            serverUserId: 'user-1',
            device: 'iPhone',
            platform: 'iOS',
            deviceId: 'device-4',
          }),
        ],
      });

      expect(evaluateRule(mobileCtx).matched).toBe(false);
    });
  });
});

describe('evaluateRules', () => {
  it('returns only matching rules', () => {
    const rules: RuleV2[] = [
      createMockRule({
        id: 'rule-1',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
        },
        actions: { actions: [{ type: 'log_only' }] },
      }),
      createMockRule({
        id: 'rule-2',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: false }] }],
        },
        actions: { actions: [{ type: 'notify', channels: ['push'] }] },
      }),
    ];

    const server = createMockServer();
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      isTranscode: true,
    });

    const results = evaluateRules(
      { session, serverUser, server, activeSessions: [session], recentSessions: [session] },
      rules
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe('rule-1');
  });

  it('skips inactive rules', () => {
    const rules: RuleV2[] = [
      createMockRule({
        id: 'rule-1',
        isActive: false,
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-2',
        isActive: true,
        conditions: { groups: [] },
      }),
    ];

    const server = createMockServer();
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

    const results = evaluateRules(
      { session, serverUser, server, activeSessions: [session], recentSessions: [session] },
      rules
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe('rule-2');
  });

  it('respects server scope', () => {
    const rules: RuleV2[] = [
      createMockRule({
        id: 'rule-1',
        serverId: 'server-1',
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-2',
        serverId: 'server-2',
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-3',
        serverId: null, // Global rule
        conditions: { groups: [] },
      }),
    ];

    const server = createMockServer({ id: 'server-1' });
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

    const results = evaluateRules(
      { session, serverUser, server, activeSessions: [session], recentSessions: [session] },
      rules
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.ruleId).sort()).toEqual(['rule-1', 'rule-3']);
  });
});

describe('async evaluation', () => {
  it('evaluateRuleAsync works correctly', async () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
      },
      actions: { actions: [{ type: 'log_only' }] },
    });

    const ctx = createTestContext(rule, {
      session: createMockSession({ isTranscode: true }),
    });

    const result = await evaluateRuleAsync(ctx);

    expect(result.matched).toBe(true);
    expect(result.actions).toEqual([{ type: 'log_only' }]);
  });

  it('evaluateRulesAsync works correctly', async () => {
    const rules: RuleV2[] = [
      createMockRule({
        id: 'rule-1',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
        },
      }),
      createMockRule({
        id: 'rule-2',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: false }] }],
        },
      }),
    ];

    const server = createMockServer();
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      isTranscode: true,
    });

    const results = await evaluateRulesAsync(
      { session, serverUser, server, activeSessions: [session], recentSessions: [session] },
      rules
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe('rule-1');
  });
});

describe('hasTranscodeConditions', () => {
  it('returns true for rule with is_transcoding condition', () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
      },
    });

    expect(hasTranscodeConditions(rule)).toBe(true);
  });

  it('returns true for rule with is_transcode_downgrade condition', () => {
    const rule = createMockRule({
      conditions: {
        groups: [
          { conditions: [{ field: 'is_transcode_downgrade', operator: 'eq', value: true }] },
        ],
      },
    });

    expect(hasTranscodeConditions(rule)).toBe(true);
  });

  it('returns true for rule with output_resolution condition', () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'output_resolution', operator: 'eq', value: '720p' }] }],
      },
    });

    expect(hasTranscodeConditions(rule)).toBe(true);
  });

  it('returns false for rule with only non-transcode conditions', () => {
    const rule = createMockRule({
      conditions: {
        groups: [
          { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] },
          { conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] },
        ],
      },
    });

    expect(hasTranscodeConditions(rule)).toBe(false);
  });

  it('returns true when transcode condition is mixed with non-transcode conditions', () => {
    const rule = createMockRule({
      conditions: {
        groups: [
          { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
          { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
        ],
      },
    });

    expect(hasTranscodeConditions(rule)).toBe(true);
  });

  it('returns false for rule with null conditions', () => {
    const rule = createMockRule({
      conditions: null as unknown as { groups: [] },
    });

    expect(hasTranscodeConditions(rule)).toBe(false);
  });

  it('returns false for rule with empty groups', () => {
    const rule = createMockRule({
      conditions: { groups: [] },
    });

    expect(hasTranscodeConditions(rule)).toBe(false);
  });

  it('returns false for source_resolution (not a transcode-dependent field)', () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] }],
      },
    });

    expect(hasTranscodeConditions(rule)).toBe(false);
  });
});

describe('hasPauseConditions', () => {
  it('returns true for rule with current_pause_minutes condition', () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }] }],
      },
    });

    expect(hasPauseConditions(rule)).toBe(true);
  });

  it('returns true for rule with total_pause_minutes condition', () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'total_pause_minutes', operator: 'gte', value: 60 }] }],
      },
    });

    expect(hasPauseConditions(rule)).toBe(true);
  });

  it('returns false for rule with only non-pause conditions', () => {
    const rule = createMockRule({
      conditions: {
        groups: [
          { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] },
          { conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] },
        ],
      },
    });

    expect(hasPauseConditions(rule)).toBe(false);
  });

  it('returns true when pause condition is mixed with non-pause conditions', () => {
    const rule = createMockRule({
      conditions: {
        groups: [
          { conditions: [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }] },
          { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] },
        ],
      },
    });

    expect(hasPauseConditions(rule)).toBe(true);
  });

  it('returns false for rule with null conditions', () => {
    const rule = createMockRule({
      conditions: null as unknown as { groups: [] },
    });

    expect(hasPauseConditions(rule)).toBe(false);
  });

  it('returns false for rule with empty groups', () => {
    const rule = createMockRule({
      conditions: { groups: [] },
    });

    expect(hasPauseConditions(rule)).toBe(false);
  });
});
