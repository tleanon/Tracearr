/**
 * Library Sync Service - Fetches library items from media servers and creates snapshots
 *
 * Orchestrates the library synchronization workflow:
 * 1. Fetch items from media server in batches with rate limiting
 * 2. Upsert items to libraryItems table
 * 3. Detect additions and removals (delta detection)
 * 4. Create snapshot with aggregate statistics
 * 5. Report progress via callback for real-time updates
 */

import { eq, and, inArray, sql, gte, lt, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, libraryItems, librarySnapshots } from '../db/schema.js';
import { createMediaServerClient, type MediaLibraryItem } from './mediaServer/index.js';
import type { LibrarySyncProgress } from '@tracearr/shared';
import { REDIS_KEYS } from '@tracearr/shared';
import { getHeavyOpsStatus } from '../jobs/heavyOpsLock.js';
import type { Redis } from 'ioredis';

// Constants for batching and rate limiting
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 150;
const BATCH_DELAY_MS_INCREMENTAL = 50;
const SYNC_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes
const SYNC_STATE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

let redisClient: Redis | null = null;

/**
 * Initialize the library sync service with a Redis client.
 * Required to enable incremental sync state persistence.
 */
export function initLibrarySyncRedis(redis: Redis): void {
  redisClient = redis;
}

/** Fields createSnapshot needs — works with both API items and DB rows */
interface SnapshotItemInput {
  fileSize?: number | null;
  videoResolution?: string | null;
  videoCodec?: string | null;
  mediaType: string;
}

/**
 * Result of syncing a single library
 */
export interface SyncResult {
  serverId: string;
  libraryId: string;
  libraryName: string;
  itemsProcessed: number;
  itemsAdded: number;
  itemsRemoved: number;
  snapshotId: string | null; // null when snapshot skipped due to incomplete sync
}

/**
 * Progress callback for real-time updates
 */
export type OnProgressCallback = (progress: LibrarySyncProgress) => void;

/**
 * Helper to delay between batches (rate limiting)
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Library Sync Service
 *
 * Handles fetching library items from media servers, persisting to database,
 * creating snapshots with quality statistics, and detecting delta changes.
 */
export class LibrarySyncService {
  /**
   * Sync all libraries for a server
   *
   * @param serverId - The server ID to sync
   * @param onProgress - Optional callback for progress updates
   * @param triggeredBy - Whether sync was triggered manually or by scheduler
   * @returns Array of SyncResult for each library
   */
  async syncServer(
    serverId: string,
    onProgress?: OnProgressCallback,
    triggeredBy: 'manual' | 'scheduled' = 'scheduled'
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    // Get server configuration
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`Server not found: ${serverId}`);
    }

    const startedAt = new Date().toISOString();

    // Create media server client
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
      id: server.id,
      name: server.name,
    });

    // Fetch all libraries and filter out unsupported types (e.g., photo libraries)
    const UNSUPPORTED_LIBRARY_TYPES = new Set(['photo', 'boxsets', 'playlists']);
    const allLibraries = await client.getLibraries();
    const libraries = allLibraries.filter((lib) => {
      if (UNSUPPORTED_LIBRARY_TYPES.has(lib.type.toLowerCase())) {
        console.log(
          `[LibrarySync] Skipping unsupported library type "${lib.type}": ${lib.name} (${lib.id})`
        );
        return false;
      }
      return true;
    });
    const totalLibraries = libraries.length;

    // Report initial progress
    if (onProgress) {
      onProgress({
        serverId,
        serverName: server.name,
        status: 'running',
        totalLibraries,
        processedLibraries: 0,
        totalItems: 0,
        processedItems: 0,
        message: `Starting sync of ${totalLibraries} libraries...`,
        startedAt,
      });
    }

    // Sync each library
    for (let i = 0; i < libraries.length; i++) {
      const library = libraries[i]!;

      const result = await this.syncLibrary(
        serverId,
        server.name,
        library.id,
        library.name,
        client,
        onProgress,
        totalLibraries,
        i,
        startedAt,
        triggeredBy
      );

      results.push(result);
    }

    // Clean up items and snapshots for libraries that no longer exist on the server.
    // Skip when server reports 0 libraries (e.g., during restart) to avoid deleting all data.
    if (libraries.length > 0) {
      const currentLibraryIds = new Set(libraries.map((lib) => lib.id));
      const cleanup = await this.cleanupOrphanedLibraries(serverId, currentLibraryIds);
      if (cleanup.removedLibraryIds.length > 0) {
        console.log(
          `[LibrarySync] Cleaned up ${cleanup.removedLibraryIds.length} orphaned libraries ` +
            `for ${server.name}: ${cleanup.removedLibraryIds.join(', ')}`
        );
      }
    }

    // Report completion
    if (onProgress) {
      const totalItems = results.reduce((sum, r) => sum + r.itemsProcessed, 0);
      const totalAdded = results.reduce((sum, r) => sum + r.itemsAdded, 0);
      const totalRemoved = results.reduce((sum, r) => sum + r.itemsRemoved, 0);

      onProgress({
        serverId,
        serverName: server.name,
        status: 'complete',
        totalLibraries,
        processedLibraries: totalLibraries,
        totalItems,
        processedItems: totalItems,
        message: `Sync complete: ${totalItems} items, ${totalAdded} added, ${totalRemoved} removed`,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    }

    return results;
  }

  /**
   * Sync a single library
   */
  private async syncLibrary(
    serverId: string,
    serverName: string,
    libraryId: string,
    libraryName: string,
    client: ReturnType<typeof createMediaServerClient>,
    onProgress: OnProgressCallback | undefined,
    totalLibraries: number,
    processedLibraries: number,
    startedAt: string,
    triggeredBy: 'manual' | 'scheduled'
  ): Promise<SyncResult> {
    // Fetch total count first
    const { totalCount } = await client.getLibraryItems(libraryId, { offset: 0, limit: 1 });

    // Load sync state from Redis
    const syncState = await this.getSyncState(serverId, libraryId);

    // Decision tree: incremental only when we have prior state, count hasn't dropped, and not manual
    const isIncremental =
      syncState.lastSyncedAt !== null &&
      syncState.lastItemCount !== null &&
      totalCount >= syncState.lastItemCount &&
      triggeredBy !== 'manual';

    if (isIncremental) {
      console.log(
        `[LibrarySync] Incremental sync for ${libraryName}: last synced ${syncState.lastSyncedAt!.toISOString()}, ` +
          `count ${syncState.lastItemCount} → ${totalCount}`
      );
    } else {
      const reason = !syncState.lastSyncedAt
        ? 'first sync'
        : totalCount < (syncState.lastItemCount ?? 0)
          ? 'items removed'
          : 'manual trigger';
      console.log(`[LibrarySync] Full sync for ${libraryName}: ${reason}`);
    }

    // Report starting library
    if (onProgress) {
      onProgress({
        serverId,
        serverName,
        status: 'running',
        currentLibrary: libraryId,
        currentLibraryName: libraryName,
        totalLibraries,
        processedLibraries,
        totalItems: totalCount,
        processedItems: 0,
        message: `Syncing library: ${libraryName} (${totalCount} items)...`,
        startedAt,
      });
    }

    // =========================================================================
    // INCREMENTAL PATH
    // =========================================================================
    if (isIncremental && client.getLibraryItemsSince) {
      try {
        const { items: newItems, totalCount: incrementalCount } = await client.getLibraryItemsSince(
          libraryId,
          syncState.lastSyncedAt!
        );

        // Check for new episodes/tracks independently — new episodes can arrive
        // for shows that were added months ago (no new Series in the result).
        let newLeaves: MediaLibraryItem[] = [];
        if (client.getLibraryLeavesSince) {
          try {
            const { items: leaves } = await client.getLibraryLeavesSince(
              libraryId,
              syncState.lastSyncedAt!
            );
            newLeaves = leaves;
          } catch (leafErr) {
            console.warn(
              `[LibrarySync] Incremental leaf fetch failed for ${libraryName}, skipping leaves:`,
              leafErr
            );
          }
        }

        if (
          incrementalCount === 0 &&
          newLeaves.length === 0 &&
          totalCount === syncState.lastItemCount
        ) {
          console.log(`[LibrarySync] ${libraryName}: no changes since last sync, skipping`);
          const snapshot = await this.copyLastSnapshot(serverId, libraryId);
          await this.saveSyncState(serverId, libraryId, totalCount);
          return {
            serverId,
            libraryId,
            libraryName,
            itemsProcessed: 0,
            itemsAdded: 0,
            itemsRemoved: 0,
            snapshotId: snapshot?.id ?? null,
          };
        }

        const allItems: MediaLibraryItem[] = [];

        for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
          const batch = newItems.slice(i, i + BATCH_SIZE);
          allItems.push(...batch);
          await this.upsertItems(serverId, libraryId, batch);

          if (i + BATCH_SIZE < newItems.length) {
            await delay(BATCH_DELAY_MS_INCREMENTAL);
          }
        }

        // Plex respects offset/limit, so paginate if more items remain
        if (newItems.length < incrementalCount) {
          let offset = newItems.length;
          while (offset < incrementalCount) {
            const { items } = await client.getLibraryItemsSince(
              libraryId,
              syncState.lastSyncedAt!,
              { offset, limit: BATCH_SIZE }
            );
            if (items.length === 0) break;

            allItems.push(...items);
            await this.upsertItems(serverId, libraryId, items);
            offset += items.length;

            if (offset < incrementalCount) {
              await delay(BATCH_DELAY_MS_INCREMENTAL);
            }
          }
        }

        for (let i = 0; i < newLeaves.length; i += BATCH_SIZE) {
          const batch = newLeaves.slice(i, i + BATCH_SIZE);
          allItems.push(...batch);
          await this.upsertItems(serverId, libraryId, batch);

          if (i + BATCH_SIZE < newLeaves.length) {
            await delay(BATCH_DELAY_MS_INCREMENTAL);
          }
        }

        // Snapshot rebuild is local DB work — don't let failures trigger a full scan
        let snapshot: { id: string } | null = null;
        try {
          const heavyOps = await getHeavyOpsStatus();
          if (!heavyOps) {
            snapshot = await this.rebuildSnapshotFromDb(serverId, libraryId);
          }
        } catch (snapshotError) {
          console.warn(
            `[LibrarySync] Failed to rebuild snapshot for ${libraryName} (items were upserted OK):`,
            snapshotError
          );
        }

        await this.saveSyncState(serverId, libraryId, totalCount);

        return {
          serverId,
          libraryId,
          libraryName,
          itemsProcessed: allItems.length,
          itemsAdded: allItems.length,
          itemsRemoved: 0,
          snapshotId: snapshot?.id ?? null,
        };
      } catch (error) {
        console.warn(
          `[LibrarySync] Incremental fetch failed for ${libraryName}, falling back to full scan:`,
          error
        );
        // Fall through to full scan path below
      }
    }

    // =========================================================================
    // FULL SCAN PATH (original code, unchanged)
    // =========================================================================

    // Get previous item keys for delta detection
    const previousKeys = await this.getPreviousItemKeys(serverId, libraryId);
    const currentKeys = new Set<string>();
    const allItems: MediaLibraryItem[] = [];

    // Fetch items in batches with pagination
    let offset = 0;
    let processedItems = 0;

    while (offset < totalCount) {
      const { items } = await client.getLibraryItems(libraryId, {
        offset,
        limit: BATCH_SIZE,
      });

      // No more items to process
      if (items.length === 0) break;

      // Track current keys for delta detection
      for (const item of items) {
        currentKeys.add(item.ratingKey);
        allItems.push(item);
      }

      // Upsert batch to database
      await this.upsertItems(serverId, libraryId, items);

      processedItems += items.length;
      offset += BATCH_SIZE;

      // Report progress
      if (onProgress) {
        onProgress({
          serverId,
          serverName,
          status: 'running',
          currentLibrary: libraryId,
          currentLibraryName: libraryName,
          totalLibraries,
          processedLibraries,
          totalItems: totalCount,
          processedItems,
          message: `${libraryName}: ${processedItems}/${totalCount} items processed...`,
          startedAt,
        });
      }

      // Rate limit between batches
      if (offset < totalCount) {
        await delay(BATCH_DELAY_MS);
      }
    }

    // For TV libraries (contains shows), also fetch all episodes
    const hasShows = allItems.some((item) => item.mediaType === 'show');
    if (hasShows && client.getLibraryLeaves) {
      // Report episode fetching
      if (onProgress) {
        onProgress({
          serverId,
          serverName,
          status: 'running',
          currentLibrary: libraryId,
          currentLibraryName: libraryName,
          totalLibraries,
          processedLibraries,
          totalItems: totalCount,
          processedItems,
          message: `${libraryName}: Fetching episodes...`,
          startedAt,
        });
      }

      // Fetch episode count
      const { totalCount: episodeCount } = await client.getLibraryLeaves(libraryId, {
        offset: 0,
        limit: 1,
      });

      // Fetch episodes in batches
      let episodeOffset = 0;
      let episodesProcessed = 0;

      while (episodeOffset < episodeCount) {
        const { items: episodes } = await client.getLibraryLeaves(libraryId, {
          offset: episodeOffset,
          limit: BATCH_SIZE,
        });

        if (episodes.length === 0) break;

        // Track episode keys and add to allItems
        for (const episode of episodes) {
          currentKeys.add(episode.ratingKey);
          allItems.push(episode);
        }

        // Upsert episodes to database
        await this.upsertItems(serverId, libraryId, episodes);

        episodesProcessed += episodes.length;
        episodeOffset += BATCH_SIZE;

        // Report progress
        if (onProgress) {
          onProgress({
            serverId,
            serverName,
            status: 'running',
            currentLibrary: libraryId,
            currentLibraryName: libraryName,
            totalLibraries,
            processedLibraries,
            totalItems: totalCount + episodeCount,
            processedItems: processedItems + episodesProcessed,
            message: `${libraryName}: ${episodesProcessed}/${episodeCount} episodes processed...`,
            startedAt,
          });
        }

        // Rate limit between batches
        if (episodeOffset < episodeCount) {
          await delay(BATCH_DELAY_MS);
        }
      }

      processedItems += episodesProcessed;
    }

    // For music libraries (contains artists), also fetch all tracks
    const hasArtists = allItems.some((item) => item.mediaType === 'artist');
    if (hasArtists && client.getLibraryLeaves) {
      // Report track fetching
      if (onProgress) {
        onProgress({
          serverId,
          serverName,
          status: 'running',
          currentLibrary: libraryId,
          currentLibraryName: libraryName,
          totalLibraries,
          processedLibraries,
          totalItems: totalCount,
          processedItems,
          message: `${libraryName}: Fetching tracks...`,
          startedAt,
        });
      }

      // Fetch track count
      const { totalCount: trackCount } = await client.getLibraryLeaves(libraryId, {
        offset: 0,
        limit: 1,
      });

      // Fetch tracks in batches
      let trackOffset = 0;
      let tracksProcessed = 0;

      while (trackOffset < trackCount) {
        const { items: tracks } = await client.getLibraryLeaves(libraryId, {
          offset: trackOffset,
          limit: BATCH_SIZE,
        });

        if (tracks.length === 0) break;

        // Track keys and add to allItems
        for (const track of tracks) {
          currentKeys.add(track.ratingKey);
          allItems.push(track);
        }

        // Upsert tracks to database
        await this.upsertItems(serverId, libraryId, tracks);

        tracksProcessed += tracks.length;
        trackOffset += BATCH_SIZE;

        // Report progress
        if (onProgress) {
          onProgress({
            serverId,
            serverName,
            status: 'running',
            currentLibrary: libraryId,
            currentLibraryName: libraryName,
            totalLibraries,
            processedLibraries,
            totalItems: totalCount + trackCount,
            processedItems: processedItems + tracksProcessed,
            message: `${libraryName}: ${tracksProcessed}/${trackCount} tracks processed...`,
            startedAt,
          });
        }

        // Rate limit between batches
        if (trackOffset < trackCount) {
          await delay(BATCH_DELAY_MS);
        }
      }

      processedItems += tracksProcessed;
    }

    // Calculate delta
    const addedKeys = [...currentKeys].filter((k) => !previousKeys.has(k));
    const removedKeys = [...previousKeys].filter((k) => !currentKeys.has(k));

    // Mark removed items (delete from database)
    if (removedKeys.length > 0) {
      await this.markItemsRemoved(serverId, libraryId, removedKeys);
    }

    // Validate sync completeness before creating snapshot
    // TV libraries with shows should have episodes, Music libraries with artists should have tracks
    const showCount = allItems.filter((i) => i.mediaType === 'show').length;
    const episodeCount = allItems.filter((i) => i.mediaType === 'episode').length;
    const artistCount = allItems.filter((i) => i.mediaType === 'artist').length;
    const trackCount = allItems.filter((i) => i.mediaType === 'track').length;

    if (showCount > 0 && episodeCount === 0) {
      console.warn(
        `[LibrarySync] Skipping snapshot for ${libraryName}: has ${showCount} shows but no episodes (likely incomplete sync)`
      );
      await this.saveSyncState(serverId, libraryId, totalCount);
      return {
        serverId,
        libraryId,
        libraryName,
        itemsProcessed: processedItems,
        itemsAdded: addedKeys.length,
        itemsRemoved: removedKeys.length,
        snapshotId: null,
      };
    }

    if (artistCount > 0 && trackCount === 0) {
      console.warn(
        `[LibrarySync] Skipping snapshot for ${libraryName}: has ${artistCount} artists but no tracks (likely incomplete sync)`
      );
      await this.saveSyncState(serverId, libraryId, totalCount);
      return {
        serverId,
        libraryId,
        libraryName,
        itemsProcessed: processedItems,
        itemsAdded: addedKeys.length,
        itemsRemoved: removedKeys.length,
        snapshotId: null,
      };
    }

    // Skip snapshot creation if a heavy operation is running (prevents deadlocks)
    // The heavy op (e.g., backfill) will create accurate snapshots when it completes
    const heavyOps = await getHeavyOpsStatus();
    if (heavyOps) {
      console.log(
        `[LibrarySync] Skipping snapshot creation - ${heavyOps.jobType} job is running: ${heavyOps.description}`
      );
      await this.saveSyncState(serverId, libraryId, totalCount);
      return {
        serverId,
        libraryId,
        libraryName,
        itemsProcessed: processedItems,
        itemsAdded: addedKeys.length,
        itemsRemoved: removedKeys.length,
        snapshotId: null,
      };
    }

    // Create snapshot (may return null if data is invalid - e.g., no file sizes)
    const snapshot = await this.createSnapshot(serverId, libraryId, allItems);

    await this.saveSyncState(serverId, libraryId, totalCount);

    return {
      serverId,
      libraryId,
      libraryName,
      itemsProcessed: processedItems,
      itemsAdded: addedKeys.length,
      itemsRemoved: removedKeys.length,
      snapshotId: snapshot?.id ?? null,
    };
  }

  /**
   * Load incremental sync state for a library from Redis.
   */
  private async getSyncState(
    serverId: string,
    libraryId: string
  ): Promise<{ lastSyncedAt: Date | null; lastItemCount: number | null }> {
    if (!redisClient) return { lastSyncedAt: null, lastItemCount: null };

    const [lastStr, countStr] = await Promise.all([
      redisClient.get(REDIS_KEYS.LIBRARY_SYNC_LAST(serverId, libraryId)),
      redisClient.get(REDIS_KEYS.LIBRARY_SYNC_COUNT(serverId, libraryId)),
    ]);

    return {
      lastSyncedAt: lastStr ? new Date(lastStr) : null,
      lastItemCount: countStr ? parseInt(countStr, 10) : null,
    };
  }

  /**
   * Persist incremental sync state for a library to Redis.
   * Stores the current time minus a safety margin so items added during sync
   * are not missed on the next incremental run.
   */
  private async saveSyncState(
    serverId: string,
    libraryId: string,
    itemCount: number
  ): Promise<void> {
    if (!redisClient) return;

    const safeTimestamp = new Date(Date.now() - SYNC_SAFETY_MARGIN_MS).toISOString();

    await Promise.all([
      redisClient.set(
        REDIS_KEYS.LIBRARY_SYNC_LAST(serverId, libraryId),
        safeTimestamp,
        'EX',
        SYNC_STATE_TTL
      ),
      redisClient.set(
        REDIS_KEYS.LIBRARY_SYNC_COUNT(serverId, libraryId),
        String(itemCount),
        'EX',
        SYNC_STATE_TTL
      ),
    ]);
  }

  /**
   * Upsert items to libraryItems table
   *
   * Uses Drizzle's onConflictDoUpdate for atomic bulk upserts.
   * Conflict target: serverId + ratingKey
   * Wrapped in transaction for atomicity - partial failures will rollback.
   */
  async upsertItems(serverId: string, libraryId: string, items: MediaLibraryItem[]): Promise<void> {
    if (items.length === 0) return;

    // Bulk upsert with transaction for atomicity
    await db.transaction(async (tx) => {
      await tx
        .insert(libraryItems)
        .values(
          items.map((item) => {
            // Defensive: ensure addedAt is a valid Date before passing to Drizzle.
            // An Invalid Date object (from malformed API data) would crash toISOString()
            let createdAt = item.addedAt;
            if (!(createdAt instanceof Date) || isNaN(createdAt.getTime())) {
              console.warn(
                `[LibrarySync] Invalid addedAt for item "${item.title}" (${item.ratingKey}), using current time`
              );
              createdAt = new Date();
            }

            return {
              serverId,
              libraryId,
              ratingKey: item.ratingKey,
              title: item.title,
              mediaType: item.mediaType,
              year: item.year ?? null,
              imdbId: item.imdbId ?? null,
              tmdbId: item.tmdbId ?? null,
              tvdbId: item.tvdbId ?? null,
              videoResolution: item.videoResolution ?? null,
              videoCodec: item.videoCodec ?? null,
              audioCodec: item.audioCodec ?? null,
              audioChannels: item.audioChannels ?? null,
              fileSize: item.fileSize ?? null,
              filePath: item.filePath ?? null,
              // Hierarchy fields (for episodes and tracks)
              grandparentTitle: item.grandparentTitle ?? null,
              grandparentRatingKey: item.grandparentRatingKey ?? null,
              parentTitle: item.parentTitle ?? null,
              parentRatingKey: item.parentRatingKey ?? null,
              parentIndex: item.parentIndex ?? null,
              itemIndex: item.itemIndex ?? null,
              createdAt,
            };
          })
        )
        .onConflictDoUpdate({
          target: [libraryItems.serverId, libraryItems.ratingKey],
          set: {
            libraryId,
            title: sql`excluded.title`,
            mediaType: sql`excluded.media_type`,
            year: sql`excluded.year`,
            imdbId: sql`excluded.imdb_id`,
            tmdbId: sql`excluded.tmdb_id`,
            tvdbId: sql`excluded.tvdb_id`,
            videoResolution: sql`excluded.video_resolution`,
            videoCodec: sql`excluded.video_codec`,
            audioCodec: sql`excluded.audio_codec`,
            audioChannels: sql`excluded.audio_channels`,
            fileSize: sql`excluded.file_size`,
            filePath: sql`excluded.file_path`,
            // Hierarchy fields (for episodes and tracks)
            grandparentTitle: sql`excluded.grandparent_title`,
            grandparentRatingKey: sql`excluded.grandparent_rating_key`,
            parentTitle: sql`excluded.parent_title`,
            parentRatingKey: sql`excluded.parent_rating_key`,
            parentIndex: sql`excluded.parent_index`,
            itemIndex: sql`excluded.item_index`,
            // Fix created_at with Plex's addedAt (for existing items with wrong dates)
            createdAt: sql`excluded.created_at`,
            updatedAt: new Date(),
          },
        });
    });
  }

  /**
   * Create a snapshot record with aggregate statistics.
   * Snapshots are only created if they would be valid (has items AND has storage size).
   * See snapshotValidation.ts for validity criteria.
   */
  async createSnapshot(
    serverId: string,
    libraryId: string,
    items: SnapshotItemInput[]
  ): Promise<{ id: string } | null> {
    // Don't create snapshots for empty libraries
    if (items.length === 0) {
      return null;
    }
    // Calculate quality distribution
    let count4k = 0;
    let count1080p = 0;
    let count720p = 0;
    let countSd = 0;
    let hevcCount = 0;
    let h264Count = 0;
    let av1Count = 0;
    let totalSize = 0;

    // Media type counts
    let movieCount = 0;
    let episodeCount = 0;
    let seasonCount = 0;
    let showCount = 0;
    let musicCount = 0;

    // Filter to only items with valid file size to match backfill behavior.
    const validItems = items.filter((item) => item.fileSize && item.fileSize > 0);

    for (const item of validItems) {
      // Resolution counts
      const res = item.videoResolution?.toLowerCase();
      if (res === '4k' || res === '2160p' || res === 'uhd') {
        count4k++;
      } else if (res === '1080p' || res === '1080') {
        count1080p++;
      } else if (res === '720p' || res === '720') {
        count720p++;
      } else if (res) {
        countSd++;
      }

      // Codec counts
      const codec = item.videoCodec?.toLowerCase();
      if (codec === 'hevc' || codec === 'h265' || codec === 'x265') {
        hevcCount++;
      } else if (codec === 'h264' || codec === 'avc' || codec === 'x264') {
        h264Count++;
      } else if (codec === 'av1') {
        av1Count++;
      }

      // File size
      totalSize += item.fileSize!;

      // Media type counts
      switch (item.mediaType) {
        case 'movie':
          movieCount++;
          break;
        case 'episode':
          episodeCount++;
          break;
        case 'season':
          seasonCount++;
          break;
        case 'show':
          showCount++;
          break;
        case 'artist':
        case 'album':
        case 'track':
          musicCount++;
          break;
      }
    }

    // Don't create snapshots with no storage size (invalid per snapshotValidation.ts)
    if (totalSize === 0) {
      return null;
    }

    // Check for existing snapshot today for this library
    // Update it if exists (better data), otherwise insert new
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [existing] = await db
      .select({ id: librarySnapshots.id, itemCount: librarySnapshots.itemCount })
      .from(librarySnapshots)
      .where(
        and(
          eq(librarySnapshots.serverId, serverId),
          eq(librarySnapshots.libraryId, libraryId),
          gte(librarySnapshots.snapshotTime, today),
          lt(librarySnapshots.snapshotTime, tomorrow)
        )
      )
      .limit(1);

    // Update existing snapshot if this one has more/better data, otherwise insert
    // Note: Don't update snapshotTime - TimescaleDB doesn't allow updates that
    // would move a row to a different chunk (causes constraint_1 violation)
    if (existing && validItems.length >= existing.itemCount) {
      await db
        .update(librarySnapshots)
        .set({
          itemCount: validItems.length,
          totalSize,
          movieCount,
          episodeCount,
          seasonCount,
          showCount,
          musicCount,
          count4k,
          count1080p,
          count720p,
          countSd,
          hevcCount,
          h264Count,
          av1Count,
          enrichmentPending: validItems.length,
          enrichmentComplete: 0,
        })
        .where(eq(librarySnapshots.id, existing.id));
      return { id: existing.id };
    }

    // No existing snapshot today, or existing has more items (don't overwrite with partial data)
    if (existing) {
      return { id: existing.id };
    }

    const [snapshot] = await db
      .insert(librarySnapshots)
      .values({
        serverId,
        libraryId,
        snapshotTime: new Date(),
        itemCount: validItems.length,
        totalSize,
        movieCount,
        episodeCount,
        seasonCount,
        showCount,
        musicCount,
        count4k,
        count1080p,
        count720p,
        countSd,
        hevcCount,
        h264Count,
        av1Count,
        enrichmentPending: validItems.length, // Valid items need enrichment
        enrichmentComplete: 0,
      })
      .returning({ id: librarySnapshots.id });

    return { id: snapshot!.id };
  }

  /**
   * Rebuild a snapshot from current library_items in the database.
   * Used after incremental syncs that added items — the DB has accurate
   * totals after upserts, so we aggregate directly from it.
   */
  private async rebuildSnapshotFromDb(
    serverId: string,
    libraryId: string
  ): Promise<{ id: string } | null> {
    const items = await db
      .select({
        fileSize: libraryItems.fileSize,
        videoResolution: libraryItems.videoResolution,
        videoCodec: libraryItems.videoCodec,
        mediaType: libraryItems.mediaType,
      })
      .from(libraryItems)
      .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.libraryId, libraryId)));

    return this.createSnapshot(serverId, libraryId, items);
  }

  /**
   * Copy the most recent snapshot to today if one doesn't already exist.
   * Used during incremental syncs when nothing changed — the library stats
   * are identical, but the growth timeline needs a data point for today.
   */
  private async copyLastSnapshot(
    serverId: string,
    libraryId: string
  ): Promise<{ id: string } | null> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Already have a snapshot today? Nothing to do.
    const [existing] = await db
      .select({ id: librarySnapshots.id })
      .from(librarySnapshots)
      .where(
        and(
          eq(librarySnapshots.serverId, serverId),
          eq(librarySnapshots.libraryId, libraryId),
          gte(librarySnapshots.snapshotTime, today),
          lt(librarySnapshots.snapshotTime, tomorrow)
        )
      )
      .limit(1);

    if (existing) return { id: existing.id };

    // Find the most recent snapshot for this library
    const [latest] = await db
      .select()
      .from(librarySnapshots)
      .where(
        and(eq(librarySnapshots.serverId, serverId), eq(librarySnapshots.libraryId, libraryId))
      )
      .orderBy(desc(librarySnapshots.snapshotTime))
      .limit(1);

    if (!latest) return null;

    // Insert a copy with today's timestamp
    const [copy] = await db
      .insert(librarySnapshots)
      .values({
        serverId,
        libraryId,
        snapshotTime: new Date(),
        itemCount: latest.itemCount,
        totalSize: latest.totalSize,
        movieCount: latest.movieCount,
        episodeCount: latest.episodeCount,
        seasonCount: latest.seasonCount,
        showCount: latest.showCount,
        musicCount: latest.musicCount,
        count4k: latest.count4k,
        count1080p: latest.count1080p,
        count720p: latest.count720p,
        countSd: latest.countSd,
        hevcCount: latest.hevcCount,
        h264Count: latest.h264Count,
        av1Count: latest.av1Count,
        enrichmentPending: 0,
        enrichmentComplete: latest.enrichmentComplete,
      })
      .returning({ id: librarySnapshots.id });

    return { id: copy!.id };
  }

  /**
   * Get server configuration from database
   */
  private async getServer(serverId: string): Promise<{
    id: string;
    name: string;
    type: 'plex' | 'jellyfin' | 'emby';
    url: string;
    token: string;
  } | null> {
    const [server] = await db
      .select({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        token: servers.token,
      })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    return server ?? null;
  }

  /**
   * Get existing item keys for a library (for delta detection)
   */
  private async getPreviousItemKeys(serverId: string, libraryId: string): Promise<Set<string>> {
    const rows = await db
      .select({ ratingKey: libraryItems.ratingKey })
      .from(libraryItems)
      .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.libraryId, libraryId)));

    return new Set(rows.map((r) => r.ratingKey));
  }

  /**
   * Remove items that no longer exist in the library
   */
  async markItemsRemoved(serverId: string, libraryId: string, ratingKeys: string[]): Promise<void> {
    if (ratingKeys.length === 0) return;

    // Delete in batches to avoid query size limits
    const BATCH_SIZE = 100;
    for (let i = 0; i < ratingKeys.length; i += BATCH_SIZE) {
      const batch = ratingKeys.slice(i, i + BATCH_SIZE);
      await db
        .delete(libraryItems)
        .where(
          and(
            eq(libraryItems.serverId, serverId),
            eq(libraryItems.libraryId, libraryId),
            inArray(libraryItems.ratingKey, batch)
          )
        );
    }
  }

  /**
   * Detect and remove items/snapshots for libraries that no longer exist on the media server.
   *
   * When users move content between libraries or delete/recreate libraries,
   * items get new IDs and the old libraryId entries become orphans.
   */
  private async cleanupOrphanedLibraries(
    serverId: string,
    currentLibraryIds: Set<string>
  ): Promise<{ removedLibraryIds: string[] }> {
    // Find distinct library IDs that exist in the DB for this server
    const itemLibraryRows = await db
      .selectDistinct({ libraryId: libraryItems.libraryId })
      .from(libraryItems)
      .where(eq(libraryItems.serverId, serverId));

    const snapshotLibraryRows = await db
      .selectDistinct({ libraryId: librarySnapshots.libraryId })
      .from(librarySnapshots)
      .where(eq(librarySnapshots.serverId, serverId));

    // Combine and subtract current library IDs to find orphans
    const allDbLibraryIds = new Set<string>();
    for (const row of itemLibraryRows) allDbLibraryIds.add(row.libraryId);
    for (const row of snapshotLibraryRows) allDbLibraryIds.add(row.libraryId);

    const orphanedIds = [...allDbLibraryIds].filter((id) => !currentLibraryIds.has(id));
    if (orphanedIds.length === 0) {
      return { removedLibraryIds: [] };
    }

    // Delete orphaned items and snapshots per library.
    const cleanedIds: string[] = [];
    let deletedSnapshots = false;

    for (const libraryId of orphanedIds) {
      try {
        await db
          .delete(libraryItems)
          .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.libraryId, libraryId)));

        await db
          .delete(librarySnapshots)
          .where(
            and(eq(librarySnapshots.serverId, serverId), eq(librarySnapshots.libraryId, libraryId))
          );

        cleanedIds.push(libraryId);
        if (snapshotLibraryRows.some((row) => row.libraryId === libraryId)) {
          deletedSnapshots = true;
        }
      } catch (err) {
        console.warn(`[LibrarySync] Failed to clean up orphaned library ${libraryId}:`, err);
      }
    }

    if (deletedSnapshots) {
      try {
        await db.execute(
          sql`CALL refresh_continuous_aggregate('library_stats_daily'::regclass, NULL, NULL)`
        );
        await db.execute(
          sql`CALL refresh_continuous_aggregate('content_quality_daily'::regclass, NULL, NULL)`
        );
      } catch (err) {
        console.warn('[LibrarySync] Failed to refresh aggregates after orphan cleanup:', err);
      }
    }

    return { removedLibraryIds: cleanedIds };
  }
}

// Export singleton instance
export const librarySyncService = new LibrarySyncService();
