/**
 * Debug routes - owner only
 *
 * Hidden utilities for development and troubleshooting.
 * All routes require owner authentication.
 */

import type { FastifyPluginAsync } from 'fastify';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { getActiveAggregateNames } from '../db/timescale.js';
import {
  clearStuckMaintenanceJobs,
  obliterateMaintenanceQueue,
  getMaintenanceQueueStats,
} from '../jobs/maintenanceQueue.js';
import { obliterateImportQueue, getImportQueueStats } from '../jobs/importQueue.js';
import { obliterateLibrarySyncQueue, getLibrarySyncQueueStats } from '../jobs/librarySyncQueue.js';
import { forceReleaseHeavyOpsLock } from '../jobs/heavyOpsLock.js';
import { getQueueStats as getNotificationQueueStats } from '../jobs/notificationQueue.js';
import { getVersionCheckQueueStats } from '../jobs/versionCheckQueue.js';
import {
  getCurrentVersion,
  getCurrentTag,
  getCurrentCommit,
  getBuildDate,
} from '../utils/buildInfo.js';
import { getInactivityCheckQueueStats } from '../jobs/inactivityCheckQueue.js';
import { getAllServices } from '../services/serviceTracker.js';
import {
  sessions,
  violations,
  users,
  servers,
  serverUsers,
  rules,
  settings,
  mobileTokens,
  mobileSessions,
  notificationPreferences,
  notificationChannelRouting,
  terminationLogs,
  plexAccounts,
  libraryItems,
  librarySnapshots,
} from '../db/schema.js';

// Gate log explorer feature to supervised deployments only
const IS_SUPERVISED = (getCurrentTag() ?? '').toLowerCase().includes('supervised');

// Specify accessible supervised log files
const SUPERVISOR_LOG_DIR = '/var/log/supervisor';
const SUPERVISOR_LOG_FILES = [
  'tracearr.log',
  'tracearr-error.log',
  'postgres.log',
  'postgres-error.log',
  'redis.log',
  'redis-error.log',
  'supervisord.log',
];
const LOG_READ_BYTES = 256 * 1024;
const LOG_LIMIT_DEFAULT = 200;
const LOG_LIMIT_MAX = 1000;

interface DebugLogEntriesResponse {
  entries: string[];
  truncated: boolean;
  fileExists: boolean;
}

const resolveLogPath = (name: string) =>
  SUPERVISOR_LOG_FILES.includes(name) ? join(SUPERVISOR_LOG_DIR, name) : null;

const readLogTail = async (filePath: string, limit: number): Promise<DebugLogEntriesResponse> => {
  try {
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      return { entries: [], truncated: false, fileExists: true };
    }

    const readBytes = Math.min(stats.size, LOG_READ_BYTES);
    const start = Math.max(0, stats.size - readBytes);
    const handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, start);
    await handle.close();

    let content = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) {
        content = content.slice(firstNewline + 1);
      }
    }

    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const truncated = start > 0 || lines.length > limit;
    const entries = lines.slice(-limit).reverse();

    return { entries, truncated, fileExists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], truncated: false, fileExists: false };
    }
    throw error;
  }
};

export const debugRoutes: FastifyPluginAsync = async (app) => {
  // All debug routes require owner
  app.addHook('preHandler', async (request, reply) => {
    await app.authenticate(request, reply);
    if (request.user?.role !== 'owner') {
      return reply.forbidden('Owner access required');
    }
  });

  /**
   * GET /debug/stats - Database statistics
   */
  app.get('/stats', async () => {
    const [
      sessionCount,
      violationCount,
      userCount,
      serverCount,
      ruleCount,
      terminationLogCount,
      libraryItemCount,
      plexAccountCount,
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(sessions),
      db.select({ count: sql<number>`count(*)::int` }).from(violations),
      db.select({ count: sql<number>`count(*)::int` }).from(users),
      db.select({ count: sql<number>`count(*)::int` }).from(servers),
      db.select({ count: sql<number>`count(*)::int` }).from(rules),
      db.select({ count: sql<number>`count(*)::int` }).from(terminationLogs),
      db.select({ count: sql<number>`count(*)::int` }).from(libraryItems),
      db.select({ count: sql<number>`count(*)::int` }).from(plexAccounts),
    ]);

    // Get database size
    const dbSize = await db.execute(sql`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size
    `);

    // Get table sizes - split into application tables and system/aggregate tables
    const appTables = await db.execute(sql`
      SELECT
        relname as table_name,
        pg_size_pretty(pg_total_relation_size(relid)) as total_size,
        pg_total_relation_size(relid) as size_bytes
      FROM pg_catalog.pg_statio_user_tables
      WHERE relname IN (
        'sessions', 'users', 'servers', 'server_users', 'rules', 'violations',
        'termination_logs', 'plex_accounts', 'settings',
        'notification_preferences', 'notification_channel_routing',
        'mobile_sessions', 'mobile_tokens',
        'library_items', 'library_snapshots'
      )
      ORDER BY pg_total_relation_size(relid) DESC
    `);

    // Get continuous aggregates and materialized views
    const aggregateTables = await db.execute(sql`
      SELECT
        view_name as table_name,
        pg_size_pretty(
          COALESCE(
            (SELECT pg_total_relation_size(format('_timescaledb_internal.%I', materialization_hypertable_name)::regclass)
             FROM timescaledb_information.continuous_aggregates ca2
             WHERE ca2.view_name = ca.view_name),
            0
          )
        ) as total_size,
        COALESCE(
          (SELECT pg_total_relation_size(format('_timescaledb_internal.%I', materialization_hypertable_name)::regclass)
           FROM timescaledb_information.continuous_aggregates ca2
           WHERE ca2.view_name = ca.view_name),
          0
        ) as size_bytes
      FROM timescaledb_information.continuous_aggregates ca
      ORDER BY size_bytes DESC
    `);

    return {
      counts: {
        sessions: sessionCount[0]?.count ?? 0,
        violations: violationCount[0]?.count ?? 0,
        users: userCount[0]?.count ?? 0,
        servers: serverCount[0]?.count ?? 0,
        rules: ruleCount[0]?.count ?? 0,
        terminationLogs: terminationLogCount[0]?.count ?? 0,
        libraryItems: libraryItemCount[0]?.count ?? 0,
        plexAccounts: plexAccountCount[0]?.count ?? 0,
      },
      database: {
        size: (dbSize.rows[0] as { size: string })?.size ?? 'unknown',
        tables: appTables.rows as { table_name: string; total_size: string }[],
        aggregates: aggregateTables.rows as { table_name: string; total_size: string }[],
      },
    };
  });

  /**
   * DELETE /debug/sessions - Clear all sessions
   */
  app.delete('/sessions', async () => {
    // Delete violations first (FK constraint)
    const violationsDeleted = await db.delete(violations).returning({ id: violations.id });
    // Delete termination logs (references sessions but no FK due to TimescaleDB)
    const terminationLogsDeleted = await db
      .delete(terminationLogs)
      .returning({ id: terminationLogs.id });
    const sessionsDeleted = await db.delete(sessions).returning({ id: sessions.id });

    return {
      success: true,
      deleted: {
        sessions: sessionsDeleted.length,
        violations: violationsDeleted.length,
        terminationLogs: terminationLogsDeleted.length,
      },
    };
  });

  /**
   * DELETE /debug/violations - Clear all violations
   */
  app.delete('/violations', async () => {
    const deleted = await db.delete(violations).returning({ id: violations.id });
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/users - Clear all non-owner users
   */
  app.delete('/users', async () => {
    // Delete sessions and violations for non-owner users first
    const nonOwnerUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`role != 'owner'`);

    const userIds = nonOwnerUsers.map((u) => u.id);

    if (userIds.length === 0) {
      return { success: true, deleted: 0 };
    }

    // Get serverUser IDs for these users (sessions/violations link to serverUsers, not users)
    const userIdArray = sql.raw(`ARRAY[${userIds.map((id) => `'${id}'::uuid`).join(',')}]`);
    const serverUserRows = await db
      .select({ id: serverUsers.id })
      .from(serverUsers)
      .where(sql`user_id = ANY(${userIdArray})`);

    const serverUserIds = serverUserRows.map((su) => su.id);

    if (serverUserIds.length > 0) {
      const serverUserIdArray = sql.raw(
        `ARRAY[${serverUserIds.map((id) => `'${id}'::uuid`).join(',')}]`
      );

      // Delete violations for these server users
      await db.delete(violations).where(sql`server_user_id = ANY(${serverUserIdArray})`);

      // Delete termination logs for these server users
      await db.delete(terminationLogs).where(sql`server_user_id = ANY(${serverUserIdArray})`);

      // Delete sessions for these server users
      await db.delete(sessions).where(sql`server_user_id = ANY(${serverUserIdArray})`);
    }

    // Delete the users (cascades to serverUsers, plexAccounts, mobileTokens, mobileSessions)
    const deleted = await db
      .delete(users)
      .where(sql`role != 'owner'`)
      .returning({ id: users.id });

    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/servers - Clear all servers (cascades to users, sessions, violations)
   */
  app.delete('/servers', async () => {
    const deleted = await db.delete(servers).returning({ id: servers.id });
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/rules - Clear all rules
   */
  app.delete('/rules', async () => {
    // Delete violations first (FK constraint)
    await db.delete(violations);
    const deleted = await db.delete(rules).returning({ id: rules.id });
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/library - Clear all library data (items and snapshots)
   */
  app.delete('/library', async () => {
    const snapshotsDeleted = await db
      .delete(librarySnapshots)
      .returning({ id: librarySnapshots.id });
    const itemsDeleted = await db.delete(libraryItems).returning({ id: libraryItems.id });
    return {
      success: true,
      deleted: {
        items: itemsDeleted.length,
        snapshots: snapshotsDeleted.length,
      },
    };
  });

  /**
   * DELETE /debug/termination-logs - Clear all termination logs
   */
  app.delete('/termination-logs', async () => {
    const deleted = await db.delete(terminationLogs).returning({ id: terminationLogs.id });
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/mobile - Delete all mobile pairing tokens and sessions
   */
  app.delete('/mobile', async () => {
    const sessionsDeleted = await db.delete(mobileSessions).returning({ id: mobileSessions.id });
    const tokensDeleted = await db.delete(mobileTokens).returning({ id: mobileTokens.id });
    return {
      success: true,
      sessionsDeleted: sessionsDeleted.length,
      tokensDeleted: tokensDeleted.length,
    };
  });

  /**
   * POST /debug/reset - Full factory reset (deletes everything including owner)
   */
  app.post('/reset', async () => {
    // Delete everything in order respecting FK constraints
    // Start with tables that have FK dependencies on other tables
    await db.delete(violations);
    await db.delete(terminationLogs);
    await db.delete(sessions);
    await db.delete(rules);
    await db.delete(notificationChannelRouting);
    await db.delete(notificationPreferences);
    await db.delete(mobileSessions);
    await db.delete(mobileTokens);
    await db.delete(librarySnapshots); // Library data (references servers)
    await db.delete(libraryItems); // Library data (references servers)
    await db.delete(serverUsers);
    await db.delete(servers); // servers references plex_accounts
    await db.delete(plexAccounts); // plex_accounts references users
    await db.delete(users);

    // Reset settings to defaults
    await db
      .update(settings)
      .set({
        allowGuestAccess: false,
        discordWebhookUrl: null,
        customWebhookUrl: null,
        pollerEnabled: true,
        pollerIntervalMs: 15000,
        tautulliUrl: null,
        tautulliApiKey: null,
      })
      .where(sql`id = 1`);

    return {
      success: true,
      message: 'Factory reset complete. Please set up Tracearr again.',
    };
  });

  /**
   * POST /debug/refresh-aggregates - Refresh TimescaleDB continuous aggregates
   */
  app.post('/refresh-aggregates', async () => {
    try {
      // Refresh all active continuous aggregates with bounded time range
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000); // Last 7 days

      // Use the centralized aggregate list to stay in sync with timescale.ts
      const aggregates = getActiveAggregateNames();

      // Convert to ISO strings - CALL statements need explicit type hints
      const startStr = startTime.toISOString();
      const endStr = endTime.toISOString();

      for (const agg of aggregates) {
        try {
          // Use parameterized query - agg::regclass validates it's a real relation
          await db.execute(
            sql`CALL refresh_continuous_aggregate(${agg}::regclass, ${startStr}::timestamptz, ${endStr}::timestamptz)`
          );
        } catch {
          // Individual aggregate might not exist - continue with others
        }
      }

      return { success: true, message: 'Aggregates refreshed (last 7 days)' };
    } catch {
      // Aggregates might not exist yet
      return { success: false, message: 'Aggregates not configured or refresh failed' };
    }
  });

  /**
   * POST /debug/clear-stuck-jobs - Clear stuck maintenance jobs
   *
   * Use this to recover from a crash where jobs are left in active state.
   */
  app.post('/clear-stuck-jobs', async () => {
    const result = await clearStuckMaintenanceJobs();
    return {
      success: true,
      message:
        result.cleared > 0 ? `Cleared ${result.cleared} stuck job(s)` : 'No stuck jobs found',
      cleared: result.cleared,
    };
  });

  /**
   * POST /debug/obliterate-all-jobs - Nuclear option: clear ALL jobs from ALL queues
   *
   * Completely wipes maintenance, import, and library sync queues.
   * Also releases any heavy operation locks.
   * Use when job system is in an unrecoverable state.
   */
  app.post('/obliterate-all-jobs', async () => {
    const results = await Promise.all([
      obliterateMaintenanceQueue(),
      obliterateImportQueue(),
      obliterateLibrarySyncQueue(),
    ]);

    // Also release any heavy ops lock
    await forceReleaseHeavyOpsLock();

    const allSuccess = results.every((r) => r.success);

    return {
      success: allSuccess,
      message: allSuccess
        ? 'All job queues obliterated and locks released'
        : 'Some queues failed to obliterate (check logs)',
      queues: {
        maintenance: results[0].success,
        import: results[1].success,
        librarySync: results[2].success,
      },
    };
  });

  /**
   * GET /debug/logs - Available supervised log files
   */
  app.get('/logs', async (_request, reply) => {
    if (!IS_SUPERVISED) {
      return reply.notFound('Log explorer is only available in supervised mode');
    }

    const files = await Promise.all(
      SUPERVISOR_LOG_FILES.map(async (name) => {
        const filePath = resolveLogPath(name);
        if (!filePath) {
          return { name, exists: false };
        }
        try {
          await fs.stat(filePath);
          return { name, exists: true };
        } catch {
          return { name, exists: false };
        }
      })
    );

    return { files };
  });

  /**
   * GET /debug/logs/:name - Tail supervised log file
   */
  app.get('/logs/:name', async (request, reply) => {
    if (!IS_SUPERVISED) {
      return reply.notFound('Log explorer is only available in supervised mode');
    }

    const { name } = request.params as { name: string };
    const { limit } = request.query as { limit?: string };
    const filePath = resolveLogPath(name);
    if (!filePath) {
      return reply.notFound('Log file not found');
    }

    const parsedLimit = Math.min(
      Math.max(Number.parseInt(limit ?? String(LOG_LIMIT_DEFAULT), 10) || LOG_LIMIT_DEFAULT, 1),
      LOG_LIMIT_MAX
    );

    return readLogTail(filePath, parsedLimit);
  });

  /**
   * GET /debug/env - Safe environment info (no secrets)
   */
  app.get('/env', async () => {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.round(process.uptime()),
      memoryUsage: {
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`,
        rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      },
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'development',
        DATABASE_URL: process.env.DATABASE_URL ? '[set]' : '[not set]',
        REDIS_URL: process.env.REDIS_URL ? '[set]' : '[not set]',
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ? '[set]' : '[not set]',
        GEOIP_DB_PATH: process.env.GEOIP_DB_PATH ?? '[not set]',
        APP_VERSION: getCurrentVersion(),
        APP_TAG: getCurrentTag() ?? '[not set]',
        APP_COMMIT: getCurrentCommit() ?? '[not set]',
        APP_BUILD_DATE: getBuildDate() ?? '[not set]',
      },
    };
  });

  /**
   * GET /debug/tasks - Background task and queue status
   */
  app.get('/tasks', async () => {
    const [notifications, imports, maintenance, librarySync, versionCheck, inactivityCheck] =
      await Promise.all([
        getNotificationQueueStats(),
        getImportQueueStats(),
        getMaintenanceQueueStats(),
        getLibrarySyncQueueStats(),
        getVersionCheckQueueStats(),
        getInactivityCheckQueueStats(),
      ]);

    return {
      queues: {
        notifications,
        imports,
        maintenance,
        librarySync,
        versionCheck,
        inactivityCheck,
      },
      services: getAllServices(),
      timestamp: new Date().toISOString(),
    };
  });
};
