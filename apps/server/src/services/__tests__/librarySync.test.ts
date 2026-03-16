/**
 * Library Sync Service Tests
 *
 * Tests for the LibrarySyncService that orchestrates library synchronization:
 * - Fetching items from media servers
 * - Upserting items to database
 * - Delta detection (additions/removals)
 * - Snapshot creation with quality statistics
 * - Progress reporting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// Mock the database
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock the media server client factory
vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

// Import after mocking
import { db } from '../../db/client.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { LibrarySyncService, initLibrarySyncRedis } from '../librarySync.js';
import type { MediaLibraryItem } from '../mediaServer/types.js';
import type { LibrarySyncProgress } from '@tracearr/shared';
import type { Redis } from 'ioredis';

// ============================================================================
// Test Data Factories
// ============================================================================

function createMockServer(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: 'Test Server',
    type: 'plex' as const,
    url: 'http://localhost:32400',
    token: 'test-token',
    ...overrides,
  };
}

function createMockLibrary(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    name: 'Movies',
    type: 'movie',
    ...overrides,
  };
}

function createMockLibraryItem(overrides: Partial<MediaLibraryItem> = {}): MediaLibraryItem {
  return {
    ratingKey: randomUUID(),
    title: 'Test Movie',
    mediaType: 'movie',
    year: 2024,
    addedAt: new Date(),
    videoResolution: '1080p',
    videoCodec: 'h264',
    audioCodec: 'aac',
    fileSize: 5000000000,
    ...overrides,
  };
}

function createMockDbItem(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    serverId: randomUUID(),
    libraryId: '1',
    ratingKey: 'rating-key-123',
    title: 'Test Movie',
    mediaType: 'movie',
    year: 2024,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    videoResolution: '1080p',
    videoCodec: 'h264',
    audioCodec: 'aac',
    fileSize: 5000000000,
    filePath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Mock Helpers
// ============================================================================

function mockSelectChain(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockInsertChain(result: unknown[] = []) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

function mockDeleteChain() {
  const chain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.delete).mockReturnValue(chain as never);
  return chain;
}

function mockTransaction() {
  // Create a mock tx object with insert chain
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  const deleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  const tx = {
    insert: vi.fn().mockReturnValue(insertChain),
    delete: vi.fn().mockReturnValue(deleteChain),
  };
  // Transaction executes the callback with tx and returns its result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
    return callback(tx);
  });
  return { tx, insertChain, deleteChain };
}

function mockSelectDistinctChain(results: unknown[][]) {
  let callCount = 0;
  const mock = vi.fn().mockImplementation(() => {
    const result = results[callCount] ?? [];
    callCount++;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(result),
      }),
    } as never;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked((db as any).selectDistinct as ReturnType<typeof vi.fn>).mockImplementation(mock);
  return mock;
}

function mockMediaServerClient(options: {
  libraries?: ReturnType<typeof createMockLibrary>[];
  items?: MediaLibraryItem[];
  totalCount?: number;
  itemsSince?: MediaLibraryItem[];
  totalCountSince?: number;
  leavesSince?: MediaLibraryItem[];
  leavesCountSince?: number;
}) {
  const client = {
    getLibraries: vi.fn().mockResolvedValue(options.libraries ?? [createMockLibrary()]),
    getLibraryItems: vi.fn().mockResolvedValue({
      items: options.items ?? [],
      totalCount: options.totalCount ?? options.items?.length ?? 0,
    }),
    getLibraryItemsSince: vi.fn().mockResolvedValue({
      items: options.itemsSince ?? [],
      totalCount: options.totalCountSince ?? options.itemsSince?.length ?? 0,
    }),
    getLibraryLeavesSince: vi.fn().mockResolvedValue({
      items: options.leavesSince ?? [],
      totalCount: options.leavesCountSince ?? options.leavesSince?.length ?? 0,
    }),
    serverType: 'plex' as const,
    getSessions: vi.fn(),
    getUsers: vi.fn(),
    testConnection: vi.fn(),
    terminateSession: vi.fn(),
  };
  vi.mocked(createMediaServerClient).mockReturnValue(client);
  return client;
}

function createMockRedis(overrides: Partial<Record<string, unknown>> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  } as unknown as Redis;
}

/**
 * Helper to set up a standard select chain for incremental sync tests.
 * Returns server on first call, empty on subsequent calls.
 */
function setupSelectForIncrementalTest(mockServer: ReturnType<typeof createMockServer>) {
  let selectCallCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    selectCallCount++;
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        const whereResult = Promise.resolve([]);
        (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
          .fn()
          .mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          });
        return whereResult;
      }),
      limit: vi.fn().mockImplementation(() => {
        if (selectCallCount === 1) return Promise.resolve([mockServer]);
        return Promise.resolve([]);
      }),
      returning: vi.fn().mockResolvedValue([]),
    };
    return chain as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no orphaned libraries (selectDistinct returns matching current libraries)
  mockSelectDistinctChain([[], []]);
});

// ============================================================================
// Tests
// ============================================================================

describe('LibrarySyncService', () => {
  describe('syncServer', () => {
    it('should throw error when server not found', async () => {
      const service = new LibrarySyncService();
      mockSelectChain([]);

      await expect(service.syncServer('non-existent-id')).rejects.toThrow(
        'Server not found: non-existent-id'
      );
    });

    it('should sync all libraries and return results', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [
        createMockLibrary({ id: '1', name: 'Movies' }),
        createMockLibrary({ id: '2', name: 'TV Shows', type: 'show' }),
      ];
      const mockItems = [
        createMockLibraryItem({ ratingKey: 'item-1' }),
        createMockLibraryItem({ ratingKey: 'item-2' }),
      ];

      // First call returns server, subsequent calls return empty (no existing items)
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        // Create a thenable chain that resolves for getPreviousItemKeys (no .limit())
        // and also for getServer (.limit())
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            // For getPreviousItemKeys, resolves via implicit await on .where()
            const whereResult = Promise.resolve([]);
            // Make it thenable and also have .limit() for getServer
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                // First call: server lookup
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                // Subsequent calls: empty (no existing items)
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: mockItems,
        totalCount: 2,
      });

      const results = await service.syncServer(mockServer.id);

      expect(results).toHaveLength(2);
      expect(results[0]!.libraryId).toBe('1');
      expect(results[1]!.libraryId).toBe('2');
      expect(createMediaServerClient).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'plex',
          url: 'http://localhost:32400',
          token: 'test-token',
        })
      );
    });

    it('should skip photo libraries during sync', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [
        createMockLibrary({ id: '1', name: 'Movies', type: 'movie' }),
        createMockLibrary({ id: '2', name: 'Photos', type: 'photo' }),
        createMockLibrary({ id: '3', name: 'TV Shows', type: 'show' }),
      ];
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: mockItems,
        totalCount: 1,
      });

      const results = await service.syncServer(mockServer.id);

      // Photo library should be filtered out - only Movies and TV Shows synced
      expect(results).toHaveLength(2);
      expect(results[0]!.libraryId).toBe('1');
      expect(results[1]!.libraryId).toBe('3');
    });

    it('should report progress via callback', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary()];
      const mockItems = [createMockLibraryItem()];
      const progressUpdates: LibrarySyncProgress[] = [];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: mockItems,
        totalCount: 1,
      });

      await service.syncServer(mockServer.id, (progress) => {
        progressUpdates.push({ ...progress });
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0]!.status).toBe('running');
      expect(progressUpdates[progressUpdates.length - 1]!.status).toBe('complete');
    });
  });

  describe('upsertItems', () => {
    it('should insert new items to database', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ ratingKey: 'item-1', title: 'Movie 1' }),
        createMockLibraryItem({ ratingKey: 'item-2', title: 'Movie 2' }),
      ];

      const { tx, insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, items);

      expect(tx.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalled();
      expect(insertChain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it('should handle empty items array', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';

      await service.upsertItems(serverId, libraryId, []);

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should map all MediaLibraryItem fields correctly', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const item = createMockLibraryItem({
        ratingKey: 'test-key',
        title: 'Test Title',
        mediaType: 'movie',
        year: 2024,
        videoResolution: '4k',
        videoCodec: 'hevc',
        audioCodec: 'truehd',
        fileSize: 10000000000,
        imdbId: 'tt1234567',
        tmdbId: 12345,
        tvdbId: 67890,
        filePath: '/movies/test.mkv',
      });

      const { insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, [item]);

      expect(insertChain.values).toHaveBeenCalledWith([
        expect.objectContaining({
          serverId,
          libraryId,
          ratingKey: 'test-key',
          title: 'Test Title',
          mediaType: 'movie',
          year: 2024,
          videoResolution: '4k',
          videoCodec: 'hevc',
          audioCodec: 'truehd',
          fileSize: 10000000000,
          imdbId: 'tt1234567',
          tmdbId: 12345,
          tvdbId: 67890,
          filePath: '/movies/test.mkv',
        }),
      ]);
    });
  });

  describe('createSnapshot', () => {
    it('should create snapshot with correct item count', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const snapshotId = randomUUID();
      const items = [createMockLibraryItem(), createMockLibraryItem(), createMockLibraryItem()];

      const insertChain = mockInsertChain([{ id: snapshotId }]);

      const result = await service.createSnapshot(serverId, libraryId, items);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(snapshotId);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId,
          libraryId,
          itemCount: 3,
        })
      );
    });

    it('should calculate quality distribution correctly', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ videoResolution: '4k', videoCodec: 'hevc' }),
        createMockLibraryItem({ videoResolution: '4k', videoCodec: 'hevc' }),
        createMockLibraryItem({ videoResolution: '1080p', videoCodec: 'h264' }),
        createMockLibraryItem({ videoResolution: '720p', videoCodec: 'h264' }),
        createMockLibraryItem({ videoResolution: '480p', videoCodec: 'h264' }),
      ];

      const insertChain = mockInsertChain([{ id: randomUUID() }]);

      await service.createSnapshot(serverId, libraryId, items);

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          count4k: 2,
          count1080p: 1,
          count720p: 1,
          countSd: 1,
          hevcCount: 2,
          h264Count: 3,
        })
      );
    });

    it('should calculate total file size', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ fileSize: 5000000000 }),
        createMockLibraryItem({ fileSize: 3000000000 }),
        createMockLibraryItem({ fileSize: undefined }),
      ];

      const insertChain = mockInsertChain([{ id: randomUUID() }]);

      await service.createSnapshot(serverId, libraryId, items);

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          totalSize: 8000000000,
        })
      );
    });

    it('should count media types correctly', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ mediaType: 'movie' }),
        createMockLibraryItem({ mediaType: 'movie' }),
        createMockLibraryItem({ mediaType: 'episode' }),
        createMockLibraryItem({ mediaType: 'show' }),
        createMockLibraryItem({ mediaType: 'track' }),
      ];

      const insertChain = mockInsertChain([{ id: randomUUID() }]);

      await service.createSnapshot(serverId, libraryId, items);

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          movieCount: 2,
          episodeCount: 1,
          showCount: 1,
          musicCount: 1,
        })
      );
    });
  });

  describe('markItemsRemoved', () => {
    it('should delete items from database', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const ratingKeys = ['key-1', 'key-2', 'key-3'];

      const deleteChain = mockDeleteChain();

      await service.markItemsRemoved(serverId, libraryId, ratingKeys);

      expect(db.delete).toHaveBeenCalled();
      expect(deleteChain.where).toHaveBeenCalled();
    });

    it('should handle empty ratingKeys array', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';

      await service.markItemsRemoved(serverId, libraryId, []);

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('should batch delete for large arrays', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      // Create 250 keys (should result in 3 batches of 100)
      const ratingKeys = Array.from({ length: 250 }, (_, i) => `key-${i}`);

      mockDeleteChain();

      await service.markItemsRemoved(serverId, libraryId, ratingKeys);

      // Should be called 3 times (batches of 100, 100, 50)
      expect(db.delete).toHaveBeenCalledTimes(3);
    });
  });

  describe('delta detection', () => {
    it('should detect added items', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary()];
      // Existing items in DB
      const existingItems = [createMockDbItem({ ratingKey: 'existing-1' })];
      // Items from server (existing + new)
      const serverItems = [
        createMockLibraryItem({ ratingKey: 'existing-1' }),
        createMockLibraryItem({ ratingKey: 'new-1' }),
        createMockLibraryItem({ ratingKey: 'new-2' }),
      ];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            // For getPreviousItemKeys - returns existing items via implicit await
            const whereResult = Promise.resolve(existingItems);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                // First call: server lookup
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve(existingItems);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve(existingItems);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: serverItems,
        totalCount: 3,
      });

      const results = await service.syncServer(mockServer.id);

      expect(results[0]!.itemsAdded).toBe(2); // new-1 and new-2
    });

    it('should detect removed items', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary()];
      // Existing items in DB
      const existingItems = [
        createMockDbItem({ ratingKey: 'item-1' }),
        createMockDbItem({ ratingKey: 'item-2' }),
        createMockDbItem({ ratingKey: 'item-3' }),
      ];
      // Items from server (missing item-2)
      const serverItems = [
        createMockLibraryItem({ ratingKey: 'item-1' }),
        createMockLibraryItem({ ratingKey: 'item-3' }),
      ];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve(existingItems);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve(existingItems);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve(existingItems);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: serverItems,
        totalCount: 2,
      });

      const results = await service.syncServer(mockServer.id);

      expect(results[0]!.itemsRemoved).toBe(1); // item-2 removed
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('incremental sync', () => {
    const serverId = randomUUID();

    beforeEach(() => {
      // Reset Redis client between tests
      initLibrarySyncRedis(null as unknown as Redis);
    });

    it('does full scan when no lastSyncedAt exists', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: vi.fn().mockResolvedValue(null), // no sync state
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      // Full scan uses getLibraryItems (not getLibraryItemsSince) for the batch loop
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 100 });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('does full scan when totalCount < lastItemCount', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      // Redis says we had 100 items, but server now reports 90 — items were removed
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(new Date(Date.now() - 60_000).toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('100'), // lastItemCount
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 90, // fewer than lastItemCount=100
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 100 });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('does full scan when triggeredBy is manual', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      // Redis has valid sync state — but it's a manual trigger
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(new Date(Date.now() - 60_000).toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('1'), // lastItemCount matches
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId, undefined, 'manual');

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 100 });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('does incremental scan when conditions are met', async () => {
      const mockServer = createMockServer({ id: serverId });
      const newItem = createMockLibraryItem({ ratingKey: 'new-item' });
      const snapshotId = randomUUID();
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(lastSyncedAt.toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('5'), // lastItemCount = 5, totalCount = 6
      });
      initLibrarySyncRedis(mockRedis);

      // Select mock: getServer → items from DB → no existing snapshot today
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            // Call 2: rebuildSnapshotFromDb queries library_items
            if (selectCallCount === 2) {
              const itemsResult = Promise.resolve([
                createMockDbItem({
                  fileSize: 5_000_000_000,
                  videoResolution: '1080p',
                  videoCodec: 'h264',
                  mediaType: 'movie',
                }),
              ]);
              (itemsResult as typeof itemsResult & { limit: typeof vi.fn }).limit = vi
                .fn()
                .mockResolvedValue([]);
              return itemsResult;
            }
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      // Insert mock: createSnapshot inserts into library_snapshots
      const insertChain = {
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: snapshotId }]),
      };
      vi.mocked(db.insert).mockReturnValue(insertChain as never);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [], // full scan returns nothing (shouldn't be called for batch loop)
        totalCount: 6,
        itemsSince: [newItem],
        totalCountSince: 1,
      });

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date));
      expect(client.getLibraryLeavesSince).toHaveBeenCalled();
      expect(results[0]!.itemsAdded).toBe(1);
      expect(results[0]!.itemsRemoved).toBe(0);
      // Incremental syncs now rebuild snapshots from DB items
      expect(results[0]!.snapshotId).toBe(snapshotId);
    });

    it('skips when incremental finds 0 items and count matches', async () => {
      const mockServer = createMockServer({ id: serverId });
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(lastSyncedAt.toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('5'), // lastItemCount = 5, totalCount = 5 (unchanged)
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [],
        totalCount: 5, // same as lastItemCount
        itemsSince: [],
        totalCountSince: 0, // 0 new items
      });

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      expect(results[0]!.itemsProcessed).toBe(0);
      expect(results[0]!.itemsAdded).toBe(0);
      expect(results[0]!.itemsRemoved).toBe(0);
      expect(results[0]!.snapshotId).toBeNull();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(client.getLibraryItemsSince).toHaveBeenCalledTimes(1);
      expect(client.getLibraryLeavesSince).toHaveBeenCalledTimes(1);
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('fetches new episodes even when no new shows exist', async () => {
      const mockServer = createMockServer({ id: serverId });
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const newEpisode = createMockLibraryItem({ ratingKey: 'new-ep-1', mediaType: 'episode' });
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(lastSyncedAt.toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('5'), // lastItemCount = 5, totalCount = 5
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [],
        totalCount: 5, // same as lastItemCount — no new shows
        itemsSince: [], // no new top-level items
        totalCountSince: 0,
        leavesSince: [newEpisode], // but there ARE new episodes
        leavesCountSince: 1,
      });

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      expect(results[0]!.itemsProcessed).toBe(1);
      expect(results[0]!.itemsAdded).toBe(1);
      expect(db.transaction).toHaveBeenCalled();
      expect(client.getLibraryLeavesSince).toHaveBeenCalled();
    });

    it('falls back to full scan when getLibraryItemsSince throws', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: vi.fn().mockResolvedValueOnce(lastSyncedAt.toISOString()).mockResolvedValueOnce('1'),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });
      // Make incremental fetch throw
      client.getLibraryItemsSince.mockRejectedValue(new Error('API error'));

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      // Should fall back to full scan
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 100 });
      expect(results[0]!.itemsProcessed).toBe(1);
    });

    it('stores sync state with 5-minute safety margin', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: vi.fn().mockResolvedValue(null),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });

      const beforeSync = Date.now();
      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      // Redis.set should have been called with the sync state keys
      const setCalls = vi.mocked(mockRedis.set).mock.calls;
      // Find the call for LIBRARY_SYNC_LAST key
      const lastCall = setCalls.find((call) => String(call[0]).includes('sync:last'));
      expect(lastCall).toBeDefined();

      // The stored timestamp should be ~5 minutes before now
      const storedTimestamp = new Date(lastCall![1] as string).getTime();
      const fiveMinutesMs = 5 * 60 * 1000;
      // Should be roughly (beforeSync - 5min), with some tolerance
      expect(storedTimestamp).toBeLessThan(beforeSync - fiveMinutesMs + 5000);
      expect(storedTimestamp).toBeGreaterThan(beforeSync - fiveMinutesMs - 5000);
    });
  });

  describe('orphaned library cleanup', () => {
    function setupSyncWithOrphans(options: {
      server: ReturnType<typeof createMockServer>;
      libraries: ReturnType<typeof createMockLibrary>[];
      items: MediaLibraryItem[];
      itemLibraryIds: { libraryId: string }[];
      snapshotLibraryIds: { libraryId: string }[];
    }) {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([options.server]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([options.server]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockSelectDistinctChain([options.itemLibraryIds, options.snapshotLibraryIds]);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: options.libraries,
        items: options.items,
        totalCount: options.items.length,
      });
    }

    it('should not clean up when no orphaned libraries exist', async () => {
      const mockServer = createMockServer();
      const libraries = [
        createMockLibrary({ id: 'lib-1', name: 'Movies' }),
        createMockLibrary({ id: 'lib-2', name: 'TV Shows', type: 'show' }),
      ];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // DB has same libraries as server
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      // Delete should only be called for normal syncLibrary operations, not for orphan cleanup
      // Verify execute was NOT called (no aggregate refresh)
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('should clean up orphaned library items and snapshots', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-2', name: 'New Movies' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      const deleteCalls = vi.mocked(db.delete).mock.calls;
      expect(deleteCalls.length).toBeGreaterThanOrEqual(2);

      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('should clean up multiple orphaned libraries', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-3', name: 'Current Library' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // DB has lib-1, lib-2 (orphaned) and lib-3 (current)
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }, { libraryId: 'lib-3' }],
        snapshotLibraryIds: [
          { libraryId: 'lib-1' },
          { libraryId: 'lib-2' },
          { libraryId: 'lib-3' },
        ],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      // Should delete for both orphaned libraries (2 deletes each: items + snapshots)
      const deleteCalls = vi.mocked(db.delete).mock.calls;
      expect(deleteCalls.length).toBeGreaterThanOrEqual(4);

      // Aggregate refresh should be called
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('should skip aggregate refresh when only items are orphaned (no snapshots)', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-2', name: 'Current' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // Orphaned lib-1 only in items, not in snapshots
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      // Delete should be called for orphan cleanup
      expect(db.delete).toHaveBeenCalled();

      // Execute should NOT be called (no orphaned snapshots = no aggregate refresh)
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('should not fail sync when aggregate refresh throws', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-2', name: 'Current' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      // Make aggregate refresh fail
      vi.mocked(db.execute).mockRejectedValue(new Error('TimescaleDB not available'));
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new LibrarySyncService();

      // Sync should complete without throwing
      await expect(service.syncServer(mockServer.id)).resolves.not.toThrow();

      // Warning should be logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to refresh aggregates'),
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    it('should not delete all data when server returns 0 libraries', async () => {
      const mockServer = createMockServer();

      setupSyncWithOrphans({
        server: mockServer,
        libraries: [], // Server returned no libraries (e.g., during restart)
        items: [],
        // DB has existing data that should NOT be deleted
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((db as any).selectDistinct).not.toHaveBeenCalled();
      // No aggregate refresh either
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('should continue cleanup if one library delete fails (compressed chunks)', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-3', name: 'Current' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // Two orphaned libraries
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }, { libraryId: 'lib-3' }],
        snapshotLibraryIds: [
          { libraryId: 'lib-1' },
          { libraryId: 'lib-2' },
          { libraryId: 'lib-3' },
        ],
      });

      // Make delete throw on the first call (simulating compressed chunk error)
      // then succeed on subsequent calls
      let deleteCallCount = 0;
      vi.mocked(db.delete).mockImplementation(() => {
        deleteCallCount++;
        return {
          where: vi.fn().mockImplementation(() => {
            // Fail on the very first orphan delete (lib-1 items)
            if (deleteCallCount === 1) {
              return Promise.reject(new Error('cannot delete from compressed chunk'));
            }
            return Promise.resolve(undefined);
          }),
        } as never;
      });

      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new LibrarySyncService();
      // Sync should complete without throwing
      await expect(service.syncServer(mockServer.id)).resolves.not.toThrow();

      // Should have warned about the failed library
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up orphaned library'),
        expect.any(Error)
      );

      // Second orphaned library should still have been attempted
      expect(deleteCallCount).toBeGreaterThan(1);

      warnSpy.mockRestore();
    });
  });
});
