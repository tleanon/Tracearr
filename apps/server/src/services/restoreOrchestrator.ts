/**
 * Server-side restore orchestrator.
 *
 * Coordinates the full restore lifecycle when triggered via the API:
 * restore point → maintenance mode → restore DB → purge Redis →
 * cleanup Tailscale → run migrations → rebuild aggregates → recovery.
 *
 * After completing the DB work, it lets the existing recovery loop
 * handle full re-initialization (initializeServices + initializePostListen)
 * rather than duplicating that logic here.
 */

import type { FastifyInstance } from 'fastify';
import type { RestorePhase } from '@tracearr/shared';
import { rm } from 'node:fs/promises';

import { isRestoring, setRestoring, setRestoreProgress, setServerMode } from '../serverState.js';

import {
  checkDumpCompatibility,
  createRestorePoint,
  extractDump,
  restoreDatabase,
  purgeRedisKeys,
  cleanupTailscaleState,
} from './backup.js';

import { closeDatabase, recreatePool, runMigrations } from '../db/client.js';
import { initTimescaleDB } from '../db/timescale.js';

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_PATH = resolve(__dirname, '../../src/db/migrations');

let lastPhase: Exclude<RestorePhase, 'failed'> = 'creating_restore_point';

function setPhase(phase: RestorePhase, message: string, error?: string): void {
  if (phase !== 'failed') lastPhase = phase;
  console.log(`[Restore] [${phase}] ${message}${error ? ` — ${error}` : ''}`);
  setRestoreProgress({
    phase,
    message,
    startedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
    ...(phase === 'failed' ? { failedAtPhase: lastPhase } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Orchestrate a full restore from a validated backup zip.
 *
 * This function is fire-and-forget — the caller returns immediately
 * and polls /health for progress.
 */
export async function orchestrateRestore(
  backupZipPath: string,
  app: FastifyInstance,
  backupTimescaleVersion?: string
): Promise<void> {
  if (isRestoring()) {
    throw new Error('A restore is already in progress');
  }

  let restorePointPath: string | undefined;

  try {
    setRestoring(true);

    // Phase 1: Restore point (fatal — we refuse to restore without a rollback path)
    setPhase('creating_restore_point', 'Creating a restore point of the current database...');
    restorePointPath = await createRestorePoint();
    app.log.info({ path: restorePointPath }, 'Restore point created');

    // Phase 2: Shut down services
    setPhase('shutting_down', 'Shutting down services...');
    setServerMode('maintenance');
    // The mode change listener will stop poller, SSE, queues, Redis subscribers, etc.
    // Give services time to fully shut down
    await sleep(2000);

    // Phase 3: Restore database
    setPhase('restoring_database', 'Restoring database from backup...');

    // Close our DB pool before restoring
    await closeDatabase();

    // Extract dump from zip and verify PG version compatibility
    const { dumpPath, tempDir } = await extractDump(backupZipPath);
    try {
      await checkDumpCompatibility(dumpPath);
      await restoreDatabase(dumpPath, backupTimescaleVersion);
      app.log.info('Database restored from backup');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    // Purge Redis (stale sessions, caches, locks, rate limits, BullMQ jobs)
    try {
      const keyCount = await purgeRedisKeys();
      app.log.info({ keyCount }, 'Redis keys purged');
    } catch (err) {
      app.log.warn({ err }, 'Failed to purge Redis — continuing');
    }

    // Clean up Tailscale ephemeral state files
    cleanupTailscaleState();
    app.log.info('Tailscale state files cleaned up');

    // Phase 4: Run migrations on restored database
    setPhase('running_migrations', 'Running database migrations...');
    await recreatePool();
    await runMigrations(MIGRATIONS_PATH);
    app.log.info('Migrations complete on restored database');

    // Phase 5: Rebuild TimescaleDB aggregates
    setPhase('rebuilding_aggregates', 'Rebuilding TimescaleDB hypertables and aggregates...');
    try {
      const result = await initTimescaleDB();
      for (const action of result.actions) {
        app.log.info(`TimescaleDB: ${action}`);
      }
    } catch (err) {
      app.log.warn({ err }, 'TimescaleDB initialization had issues — continuing');
    }

    // Phase 6: Let recovery loop take over
    setPhase('restarting', 'Restarting services...');
    setRestoring(false);
    // The recovery loop (already running from the maintenance mode transition)
    // will detect DB+Redis healthy, call initializeServices + initializePostListen,
    // and transition the server back to 'ready' mode.

    // Phase 7: Complete
    setPhase('complete', 'Restore completed successfully.');

    // Clean up restore point — no longer needed after successful restore
    if (restorePointPath) {
      await rm(restorePointPath, { force: true });
      app.log.info({ path: restorePointPath }, 'Restore point removed after successful restore');
    }

    // Clear progress after 30s so subsequent /health calls don't show stale data
    setTimeout(() => {
      setRestoreProgress(null);
    }, 30_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    app.log.error(
      { err, phase: lastPhase },
      `Restore failed during phase: ${lastPhase} — ${message}`
    );

    // Attempt automatic rollback from restore point
    if (restorePointPath) {
      app.log.info({ path: restorePointPath }, 'Attempting rollback from restore point...');
      setPhase('failed', 'Restore failed — rolling back from restore point...', message);

      try {
        await restoreDatabase(restorePointPath);
        await recreatePool();
        app.log.info('Rollback from restore point succeeded');
        setPhase('failed', 'Restore failed. Your previous data has been restored.', message);
      } catch (rollbackErr) {
        app.log.error({ err: rollbackErr }, 'Rollback from restore point also failed');
        setPhase(
          'failed',
          `Restore and rollback both failed. Restore point available at: ${restorePointPath}`,
          message
        );
        // Best-effort pool recovery so recovery loop can at least connect
        try {
          await recreatePool();
        } catch {
          // Nothing more we can do
        }
      }
    } else {
      setPhase('failed', 'Restore failed. No restore point was created.', message);
      try {
        await recreatePool();
      } catch {
        // Best effort
      }
    }

    setRestoring(false);
    // Recovery loop will attempt normal recovery
  }
}
