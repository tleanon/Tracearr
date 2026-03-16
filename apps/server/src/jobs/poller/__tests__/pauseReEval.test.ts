/**
 * Pause Re-evaluation Tests
 *
 * Tests for reEvaluateRulesOnPauseState:
 * - Only pause-related rules are evaluated (no false positives)
 * - Violations are created when pause rules match
 * - Application-level dedup prevents duplicate violations (critical: runs every poll cycle)
 * - Side effects are gated on new violation creation (not fired on dedup)
 * - Fresh pauseData is used instead of stale existingSession values
 * - Non-pause rules (concurrent_streams, transcode, etc.) are skipped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuleV2, Session } from '@tracearr/shared';
import type { PauseReEvalInput } from '../types.js';

// ============================================================================
// Module Mocks
// ============================================================================

const mockExecute = vi.fn();
const mockTxSelect = vi.fn();
const mockTxInsert = vi.fn();
const mockTxUpdate = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();
const mockSet = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../../../db/client.js', () => ({
  db: {
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
  };
});

const mockEvaluateRulesAsync = vi.fn();
vi.mock('../../../services/rules/engine.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    evaluateRulesAsync: (...args: unknown[]) => mockEvaluateRulesAsync(...args),
  };
});

const mockExecuteActions = vi.fn();
vi.mock('../../../services/rules/executors/index.js', () => ({
  executeActions: (...args: unknown[]) => mockExecuteActions(...args),
}));

const mockStoreActionResults = vi.fn();
vi.mock('../../../services/rules/v2Integration.js', () => ({
  storeActionResults: (...args: unknown[]) => mockStoreActionResults(...args),
}));

vi.mock('../../../utils/logger.js', () => ({
  pollerLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  rulesLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../services/geoip.js', () => ({
  geoipService: {
    isPrivateIP: (ip: string) =>
      ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('127.'),
  },
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockExistingSession(
  overrides: Record<string, unknown> = {}
): PauseReEvalInput['existingSession'] {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'user-1',
    sessionKey: 'sk-1',
    externalSessionId: 'ext-1',
    state: 'paused',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rk-1',
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 600000,
    lastPausedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes ago (stale)
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
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  } as PauseReEvalInput['existingSession'];
}

function createMockProcessedSession(
  overrides: Record<string, unknown> = {}
): PauseReEvalInput['processed'] {
  return {
    sessionKey: 'sk-1',
    ratingKey: 'rk-1',
    externalUserId: 'ext-user-1',
    username: 'testuser',
    userThumb: '',
    mediaTitle: 'Test Movie',
    mediaType: 'movie' as const,
    grandparentTitle: '',
    seasonNumber: 0,
    episodeNumber: 0,
    year: 2024,
    thumbPath: '',
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    ipAddress: '192.168.1.100',
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
    state: 'paused' as const,
    totalDurationMs: 7200000,
    progressMs: 600000,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  } as PauseReEvalInput['processed'];
}

function createPauseRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-pause-1',
    name: 'Kill After 15min Pause',
    description: null,
    serverId: null,
    severity: 'warning',
    isActive: true,
    conditions: {
      groups: [{ conditions: [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }] }],
    },
    actions: {
      actions: [{ type: 'kill_stream' }],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createTotalPauseRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-total-pause-1',
    name: 'Warn After 30min Total Pause',
    description: null,
    serverId: null,
    severity: 'warning',
    isActive: true,
    conditions: {
      groups: [{ conditions: [{ field: 'total_pause_minutes', operator: 'gte', value: 30 }] }],
    },
    actions: {
      actions: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createConcurrentStreamsRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-concurrent-1',
    name: 'Max 2 Concurrent Streams',
    description: null,
    serverId: null,
    severity: 'warning',
    isActive: true,
    conditions: {
      groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }] }],
    },
    actions: {
      actions: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createTranscodeRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-transcode-1',
    name: 'Block 4K Transcoding',
    description: null,
    serverId: null,
    severity: 'high',
    isActive: true,
    conditions: {
      groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
    },
    actions: {
      actions: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

function createDefaultInput(overrides: Partial<PauseReEvalInput> = {}): PauseReEvalInput {
  return {
    existingSession: createMockExistingSession(),
    processed: createMockProcessedSession(),
    pauseData: {
      lastPausedAt: tenMinutesAgo,
      pausedDurationMs: 0,
    },
    server: { id: 'server-1', name: 'Test Plex', type: 'plex' },
    serverUser: {
      id: 'user-1',
      username: 'testuser',
      thumbUrl: null,
      identityName: null,
      trustScore: 100,
      sessionCount: 10,
      lastActivityAt: new Date(),
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    },
    activeRulesV2: [createPauseRule(), createConcurrentStreamsRule()],
    activeSessions: [],
    recentSessions: [],
    ...overrides,
  };
}

function setupDbMockChain() {
  mockTransaction.mockReset();
  mockExecute.mockReset();
  mockTxSelect.mockReset();
  mockTxInsert.mockReset();
  mockTxUpdate.mockReset();
  mockFrom.mockReset();
  mockWhere.mockReset();
  mockLimit.mockReset();
  mockValues.mockReset();
  mockOnConflictDoNothing.mockReset();
  mockReturning.mockReset();
  mockSet.mockReset();

  // tx.select().from().where().limit() → dedup check
  mockTxSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([]); // No existing violations (default)

  // tx.insert().values().onConflictDoNothing().returning()
  mockTxInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  mockOnConflictDoNothing.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([
    {
      id: 'violation-1',
      ruleId: 'rule-pause-1',
      serverUserId: 'user-1',
      sessionId: 'session-1',
      severity: 'warning',
      ruleType: null,
      data: {},
      createdAt: new Date(),
      acknowledgedAt: null,
    },
  ]);

  // tx.update().set().where()
  mockTxUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  // tx.execute() → advisory lock
  mockExecute.mockResolvedValue(undefined);

  // db.transaction(async (tx) => { ... })
  const mockTx = {
    execute: mockExecute,
    select: (...args: unknown[]) => mockTxSelect(...args),
    insert: (...args: unknown[]) => mockTxInsert(...args),
    update: (...args: unknown[]) => mockTxUpdate(...args),
  };
  mockTransaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => {
    return cb(mockTx);
  });
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  setupDbMockChain();
  mockExecuteActions.mockResolvedValue([]);
  mockStoreActionResults.mockResolvedValue(undefined);
});

describe('reEvaluateRulesOnPauseState', () => {
  async function getFunction() {
    const mod = await import('../sessionLifecycle.js');
    return mod.reEvaluateRulesOnPauseState;
  }

  describe('rule filtering', () => {
    it('only evaluates pause-related rules, skipping concurrent_streams', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [_baseContext, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-pause-1');
      expect(rules[0]?.name).toBe('Kill After 15min Pause');
    });

    it('evaluates both current_pause and total_pause rules', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const input = createDefaultInput({
        activeRulesV2: [createPauseRule(), createTotalPauseRule(), createConcurrentStreamsRule()],
      });

      await reEvaluateRulesOnPauseState(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(2);
      expect(rules.map((r) => r.id)).toEqual(['rule-pause-1', 'rule-total-pause-1']);
    });

    it('returns empty array when no rules have pause conditions', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      const input = createDefaultInput({
        activeRulesV2: [createConcurrentStreamsRule(), createTranscodeRule()],
      });

      const results = await reEvaluateRulesOnPauseState(input);

      expect(results).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });

    it('returns empty array when there are no active rules', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      const input = createDefaultInput({ activeRulesV2: [] });

      const results = await reEvaluateRulesOnPauseState(input);

      expect(results).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });
  });

  describe('violation creation', () => {
    it('creates violation when pause rule matches', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      const input = createDefaultInput();
      const results = await reEvaluateRulesOnPauseState(input);

      expect(results).toHaveLength(1);
      expect(results[0]?.violation.id).toBe('violation-1');
      expect(mockTxInsert).toHaveBeenCalled();
    });

    it('includes pauseReEval marker in violation data', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      const insertValues = mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const data = insertValues?.data as Record<string, unknown>;
      expect(data?.pauseReEval).toBe(true);
    });

    it('uses severity from rule (not from actions) when creating violation', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      // Rule has severity: 'warning' (set in createPauseRule)
      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      const insertValues = mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertValues?.severity).toBe('warning');
    });
  });

  describe('deduplication', () => {
    it('skips violation creation when duplicate exists', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      // Simulate existing violation found (dedup check returns result)
      mockLimit.mockResolvedValue([{ id: 'existing-violation-1' }]);

      const input = createDefaultInput();
      const results = await reEvaluateRulesOnPauseState(input);

      expect(results).toHaveLength(0);
      expect(mockTxInsert).not.toHaveBeenCalled();
    });

    it('does NOT execute side effects when violation is deduplicated', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          // On every subsequent poll cycle while paused, the rule matches again
          // but kill_stream must NOT fire again because dedup prevents it.
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      // Simulate existing violation — this is the critical dedup scenario.
      mockLimit.mockResolvedValue([{ id: 'existing-violation-1' }]);

      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      // kill_stream should NOT fire on dedup
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockStoreActionResults).not.toHaveBeenCalled();
    });
  });

  describe('transaction safety', () => {
    it('acquires advisory lock before dedup check', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockExecute).toHaveBeenCalledTimes(1);

      const executeOrder = mockExecute.mock.invocationCallOrder[0]!;
      const selectOrder = mockTxSelect.mock.invocationCallOrder[0]!;
      expect(executeOrder).toBeLessThan(selectOrder);
    });

    it('runs dedup check and insert in same transaction', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      // 1. dedup select
      expect(mockTxSelect).toHaveBeenCalled();
      // 2. violation insert
      expect(mockTxInsert).toHaveBeenCalled();

      // Verify ordering: select (dedup) → insert
      const selectOrder = mockTxSelect.mock.invocationCallOrder[0]!;
      const insertOrder = mockTxInsert.mock.invocationCallOrder[0]!;
      expect(selectOrder).toBeLessThan(insertOrder);
    });
  });

  describe('trust score penalty', () => {
    it('does NOT automatically decrease trust score on violation creation', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      // Trust score update is handled elsewhere, not in pause re-eval
      expect(mockTxUpdate).not.toHaveBeenCalled();
    });
  });

  describe('side effect actions', () => {
    it('executes kill_stream action alongside new violation', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      mockExecuteActions.mockResolvedValue([{ action: 'kill_stream', success: true }]);

      const input = createDefaultInput();
      await reEvaluateRulesOnPauseState(input);

      expect(mockExecuteActions).toHaveBeenCalledTimes(1);
      const [_ctx, actions] = mockExecuteActions.mock.calls[0] as [unknown, { type: string }[]];
      expect(actions).toHaveLength(1);
      expect(actions[0]?.type).toBe('kill_stream');

      expect(mockStoreActionResults).toHaveBeenCalledWith('violation-1', 'rule-pause-1', [
        { action: 'kill_stream', success: true },
      ]);
    });
  });

  describe('context building', () => {
    it('uses fresh pauseData instead of stale existingSession values', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const freshPauseStart = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago (fresh)
      const stalePauseStart = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago (stale)

      const input = createDefaultInput({
        existingSession: createMockExistingSession({
          // These are STALE values from the DB (before update)
          lastPausedAt: stalePauseStart,
          pausedDurationMs: 0,
        }),
        pauseData: {
          // These are FRESH values from calculatePauseAccumulation
          lastPausedAt: freshPauseStart,
          pausedDurationMs: 300000, // 5 min accumulated
        },
      });

      await reEvaluateRulesOnPauseState(input);

      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [baseContext] = mockEvaluateRulesAsync.mock.calls[0] as [
        { session: Session },
        RuleV2[],
      ];

      // Session should use FRESH pause data, not stale existingSession values
      expect(baseContext.session.lastPausedAt).toEqual(freshPauseStart);
      expect(baseContext.session.pausedDurationMs).toBe(300000);

      // But identity fields should come from existingSession
      expect(baseContext.session.id).toBe('session-1');
      expect(baseContext.session.serverId).toBe('server-1');
      expect(baseContext.session.serverUserId).toBe('user-1');
    });

    it('uses paused state from processed data', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const input = createDefaultInput({
        processed: createMockProcessedSession({ state: 'paused' }),
        existingSession: createMockExistingSession({ state: 'playing' }), // Stale
      });

      await reEvaluateRulesOnPauseState(input);

      const [baseContext] = mockEvaluateRulesAsync.mock.calls[0] as [
        { session: Session },
        RuleV2[],
      ];
      expect(baseContext.session.state).toBe('paused');
    });
  });

  describe('false positive prevention', () => {
    it('does NOT evaluate concurrent_streams rules on pause re-eval', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const input = createDefaultInput({
        activeRulesV2: [createConcurrentStreamsRule(), createPauseRule(), createTranscodeRule()],
      });

      await reEvaluateRulesOnPauseState(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-pause-1');
    });

    it('evaluates rules with mixed pause + non-pause conditions', async () => {
      const reEvaluateRulesOnPauseState = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const mixedRule: RuleV2 = {
        id: 'rule-mixed-1',
        name: 'Pause + Concurrent',
        description: null,
        serverId: null,
        severity: 'warning',
        isActive: true,
        conditions: {
          groups: [
            { conditions: [{ field: 'current_pause_minutes', operator: 'gte', value: 10 }] },
            { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] },
          ],
        },
        actions: { actions: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const input = createDefaultInput({
        activeRulesV2: [mixedRule, createConcurrentStreamsRule()],
      });

      await reEvaluateRulesOnPauseState(input);

      // The mixed rule has a pause condition, so it should be included
      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-mixed-1');
    });
  });
});
