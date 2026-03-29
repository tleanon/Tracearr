/**
 * Maintenance routes - Administrative maintenance jobs
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, inArray } from 'drizzle-orm';
import type { MaintenanceJobType } from '@tracearr/shared';
import {
  enqueueMaintenanceJob,
  getMaintenanceProgress,
  getMaintenanceJobStatus,
  getMaintenanceQueueStats,
  getMaintenanceJobHistory,
} from '../jobs/maintenanceQueue.js';
import { db } from '../db/client.js';
import { librarySnapshots } from '../db/schema.js';

export const maintenanceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /maintenance/jobs - List available maintenance jobs
   */
  app.get('/jobs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    // Return list of available maintenance jobs with descriptions
    return {
      jobs: [
        // Normalization jobs - standardize data formats
        {
          type: 'normalize_players',
          category: 'normalization',
          name: 'Normalize Player Names',
          description:
            'Run this if you see inconsistent device names like "AndroidTv" and "Android TV", ' +
            'or raw client strings like "Jellyfin Android" instead of clean platform names.',
        },
        {
          type: 'normalize_countries',
          category: 'normalization',
          name: 'Normalize Country Codes',
          description:
            'Run this if you see both "US" and "United States" in your history, ' +
            "or if geo restriction rules aren't matching older sessions correctly.",
        },
        {
          type: 'normalize_codecs',
          category: 'normalization',
          name: 'Normalize Codec Names',
          description:
            'Converts all codec names to uppercase for consistency. ' +
            'Run this if you see duplicate codecs in the Compatibility Matrix (e.g., "h264" and "H264").',
        },
        // Backfill jobs - fill in missing historical data
        {
          type: 'fix_imported_progress',
          category: 'backfill',
          name: 'Fix Imported Session Progress',
          description:
            'Run this if imported sessions from Tautulli show "0%" progress despite having watch time. ' +
            'This recalculates progress values for sessions that were imported before this was fixed.',
        },
        {
          type: 'backfill_user_dates',
          category: 'backfill',
          name: 'Backfill User Activity Dates',
          description:
            'Populates joinedAt and lastActivityAt for users from session history. ' +
            'Run this if users show "Unknown" join dates or missing last activity timestamps.',
        },
        {
          type: 'backfill_library_snapshots',
          category: 'backfill',
          name: 'Backfill Library Snapshots',
          description:
            'Creates historical library snapshots from library_items.created_at for proper deletion/upgrade tracking. ' +
            'Run this once after upgrading to enable accurate Storage Trend and Quality Evolution charts.',
        },
        // Cleanup jobs - database maintenance and optimization
        {
          type: 'rebuild_timescale_views',
          category: 'cleanup',
          name: 'Rebuild TimescaleDB Views',
          description:
            'Recreates all TimescaleDB continuous aggregates and engagement views. ' +
            'Run this after upgrading if you see database errors about missing views or columns.',
        },
        {
          type: 'full_aggregate_rebuild',
          category: 'cleanup',
          name: 'Full Historical Aggregate Rebuild',
          description:
            'Safely refreshes all continuous aggregates from the beginning of history. ' +
            'Uses batched processing (30-day chunks) to prevent memory and file descriptor exhaustion. ' +
            'Run this if Watch Analytics shows incorrect counts for historical data.',
        },
        {
          type: 'cleanup_old_chunks',
          category: 'cleanup',
          name: 'Cleanup Old Chunks',
          description:
            'Drops old TimescaleDB chunks beyond the retention period (90 days). ' +
            'Run this if the automatic retention job fails with "out of shared memory" errors.',
        },
        {
          type: 'repair_corrupted_chunks',
          category: 'cleanup',
          name: 'Repair Corrupted Chunks',
          description:
            'Detects and repairs corrupted TimescaleDB compressed chunks. ' +
            'Run this if you see "pg_attribute catalog is missing" errors or if Library/Quality pages fail to load.',
        },
      ],
    };
  });

  /**
   * POST /maintenance/jobs/:type - Start a maintenance job
   */
  app.post<{ Params: { type: string } }>(
    '/jobs/:type',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can run maintenance jobs');
      }

      const { type } = request.params;

      // Validate job type
      const validTypes: MaintenanceJobType[] = [
        'normalize_players',
        'normalize_countries',
        'fix_imported_progress',
        'rebuild_timescale_views',
        'full_aggregate_rebuild',
        'normalize_codecs',
        'backfill_user_dates',
        'backfill_library_snapshots',
        'cleanup_old_chunks',
        'repair_corrupted_chunks',
      ];
      if (!validTypes.includes(type as MaintenanceJobType)) {
        return reply.badRequest(`Invalid job type: ${type}`);
      }

      try {
        const jobId = await enqueueMaintenanceJob(type as MaintenanceJobType, authUser.userId);
        return {
          status: 'queued',
          jobId,
          message: 'Maintenance job queued. Watch for progress updates via WebSocket.',
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('already in progress')) {
          return reply.conflict(error.message);
        }
        throw error;
      }
    }
  );

  /**
   * GET /maintenance/progress - Get current job progress (if any)
   */
  app.get('/progress', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    const progress = getMaintenanceProgress();
    return { progress };
  });

  /**
   * GET /maintenance/jobs/:jobId/status - Get specific job status
   */
  app.get<{ Params: { jobId: string } }>(
    '/jobs/:jobId/status',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can access maintenance jobs');
      }

      const { jobId } = request.params;

      // Validate jobId format (alphanumeric with dashes)
      if (!jobId || !/^[\w-]+$/.test(jobId) || jobId.length > 100) {
        return reply.badRequest('Invalid job ID format');
      }

      const status = await getMaintenanceJobStatus(jobId);

      if (!status) {
        return reply.notFound('Job not found');
      }

      return status;
    }
  );

  /**
   * GET /maintenance/stats - Get queue statistics
   */
  app.get('/stats', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    const stats = await getMaintenanceQueueStats();

    if (!stats) {
      return reply.serviceUnavailable('Maintenance queue not available');
    }

    return stats;
  });

  /**
   * GET /maintenance/history - Get recent job history
   */
  app.get('/history', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    const history = await getMaintenanceJobHistory(10);
    return { history };
  });

  /**
   * GET /maintenance/snapshots - List snapshots, optionally filtered
   *
   * Query params:
   * - suspicious: boolean - only show snapshots with total_size=0 for video libraries
   * - date: string - filter by specific date (YYYY-MM-DD)
   * - libraryId: string - filter by library
   * - limit: number - max results (default 100)
   */
  app.get<{
    Querystring: { suspicious?: string; date?: string; libraryId?: string; limit?: string };
  }>('/snapshots', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access snapshots');
    }

    const { suspicious, date, libraryId, limit } = request.query;
    const maxResults = Math.min(parseInt(limit || '100', 10), 500);

    // Build filters
    const suspiciousFilter =
      suspicious === 'true'
        ? sql`AND ls.total_size = 0 AND (ls.episode_count > 0 OR ls.movie_count > 0 OR ls.item_count > 100)`
        : sql``;

    const dateFilter = date ? sql`AND ls.snapshot_time::date = ${date}::date` : sql``;

    const libraryFilter = libraryId ? sql`AND ls.library_id = ${libraryId}` : sql``;

    const result = await db.execute(sql`
      SELECT
        ls.id,
        ls.server_id,
        s.name as server_name,
        ls.library_id,
        ls.snapshot_time,
        ls.item_count,
        ls.total_size,
        ls.movie_count,
        ls.episode_count,
        ls.music_count,
        CASE
          WHEN ls.movie_count > 0 AND ls.episode_count = 0 AND ls.music_count = 0 THEN 'Movies'
          WHEN ls.episode_count > 0 THEN 'TV Shows'
          WHEN ls.music_count > 0 THEN 'Music'
          ELSE 'Unknown'
        END as library_type,
        CASE
          WHEN ls.total_size = 0 AND (ls.episode_count > 0 OR ls.movie_count > 0 OR ls.item_count > 100)
          THEN true
          ELSE false
        END as is_suspicious
      FROM library_snapshots ls
      LEFT JOIN servers s ON s.id = ls.server_id
      WHERE 1=1
        ${suspiciousFilter}
        ${dateFilter}
        ${libraryFilter}
      ORDER BY ls.snapshot_time DESC
      LIMIT ${maxResults}
    `);

    return {
      snapshots: result.rows,
      count: result.rows.length,
    };
  });

  /**
   * DELETE /maintenance/snapshots - Delete snapshots by criteria
   *
   * Body params:
   * - ids: string[] - specific snapshot IDs to delete
   * - OR criteria object:
   *   - suspicious: boolean - delete all suspicious snapshots
   *   - date: string - delete all snapshots for a date
   *   - libraryId: string - combined with date, delete for specific library
   */
  app.delete<{
    Body: {
      ids?: string[];
      criteria?: { suspicious?: boolean; date?: string; libraryId?: string };
    };
  }>('/snapshots', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can delete snapshots');
    }

    const { ids, criteria } = request.body || {};

    if (!ids && !criteria) {
      return reply.badRequest('Must provide either ids array or criteria object');
    }

    let deletedCount = 0;

    if (ids && ids.length > 0) {
      // Validate IDs are UUIDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!ids.every((id) => uuidRegex.test(id))) {
        return reply.badRequest('Invalid snapshot ID format');
      }

      const result = await db
        .delete(librarySnapshots)
        .where(inArray(librarySnapshots.id, ids))
        .returning({ id: librarySnapshots.id });
      deletedCount = result.length;
    } else if (criteria) {
      // Build delete query based on criteria
      if (criteria.suspicious) {
        const result = await db.execute(sql`
          DELETE FROM library_snapshots
          WHERE total_size = 0
            AND (episode_count > 0 OR movie_count > 0 OR item_count > 100)
          RETURNING id
        `);
        deletedCount = result.rows.length;
      } else if (criteria.date) {
        const libraryFilter = criteria.libraryId
          ? sql`AND library_id = ${criteria.libraryId}`
          : sql``;

        const result = await db.execute(sql`
          DELETE FROM library_snapshots
          WHERE snapshot_time::date = ${criteria.date}::date
            ${libraryFilter}
          RETURNING id
        `);
        deletedCount = result.rows.length;
      } else {
        return reply.badRequest('Criteria must include suspicious=true or a date');
      }
    }

    // Refresh continuous aggregate after deletion
    if (deletedCount > 0) {
      try {
        await db.execute(sql`
          CALL refresh_continuous_aggregate(
            'library_stats_daily',
            (SELECT MIN(snapshot_time)::date FROM library_snapshots),
            NOW()::date + INTERVAL '1 day'
          )
        `);
      } catch (error) {
        console.error('[Maintenance] Failed to refresh continuous aggregate:', error);
      }
    }

    return {
      deleted: deletedCount,
      message: `Deleted ${deletedCount} snapshot(s)`,
    };
  });
};
