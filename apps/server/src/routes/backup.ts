/**
 * Backup & Restore API routes.
 *
 * All routes require owner role. Restore status is also accessible
 * through the maintenance gate (for polling during restore).
 */

import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream, createWriteStream, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { stat, statfs, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BackupScheduleType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { isRestoring } from '../serverState.js';
import { BACKUP_DIR, createBackup, validateBackup, listBackups } from '../services/backup.js';
import { orchestrateRestore } from '../services/restoreOrchestrator.js';
import { scheduleBackupJob } from '../jobs/backupQueue.js';
import { getBackupScheduleSettings, setSettings } from '../services/settings.js';

// Short-lived download tokens (in-memory, single use, 60s expiry)
const DOWNLOAD_TOKEN_TTL_MS = 60_000;
const downloadTokens = new Map<string, { filename: string; expires: number }>();

function createDownloadToken(filename: string): string {
  const token = randomBytes(32).toString('base64url');
  downloadTokens.set(token, { filename, expires: Date.now() + DOWNLOAD_TOKEN_TTL_MS });
  return token;
}

function consumeDownloadToken(token: string): string | null {
  const entry = downloadTokens.get(token);
  if (!entry) return null;
  downloadTokens.delete(token);
  if (Date.now() > entry.expires) return null;
  return entry.filename;
}

// Zod schemas for request validation
const backupFilenameSchema = z.object({
  filename: z.string().regex(/^tracearr-backup-[\d-]+\.zip$/, 'Invalid backup filename'),
});

const restoreBodySchema = z.object({
  filename: z.string().regex(/^tracearr-backup-[\d-]+\.zip$/, 'Invalid backup filename'),
});

const scheduleBodySchema = z.object({
  type: z.enum(['disabled', 'daily', 'weekly', 'monthly']),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
  dayOfWeek: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(31),
  retentionCount: z.number().int().min(1).max(30),
});

export const backupRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart for backup upload
  await app.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500MB
    },
  });

  // ==========================================================================
  // Backup Management
  // ==========================================================================

  /** POST /backup/create — Create a manual backup */
  app.post('/create', { preHandler: [app.requireOwner] }, async (_request, reply) => {
    try {
      const { filePath, metadata } = await createBackup(BACKUP_DIR, 'manual');
      return { filename: basename(filePath), metadata };
    } catch (err) {
      app.log.error({ err }, 'Failed to create backup');
      return reply.internalServerError(
        `Backup failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  });

  /** POST /backup/upload — Upload a backup zip */
  app.post('/upload', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.badRequest('No file uploaded');
    }

    if (!data.filename.endsWith('.zip')) {
      return reply.badRequest('File must be a .zip archive');
    }

    // Generate a safe filename (YYYYMMDD-HHmmss)
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `tracearr-backup-${timestamp}.zip`;
    const filePath = join(BACKUP_DIR, filename);

    try {
      // Stream file to disk
      const writeStream = createWriteStream(filePath);
      await pipeline(data.file, writeStream);

      // Validate the uploaded file
      const result = await validateBackup(filePath);
      if (!result.valid || !result.metadata) {
        // Invalid — clean up
        unlinkSync(filePath);
        return reply.badRequest(`Invalid backup: ${result.errors.join(', ')}`);
      }

      // Write sidecar metadata
      const fileStat = await stat(filePath);
      const sidecar = {
        filename,
        size: fileStat.size,
        createdAt: result.metadata.createdAt,
        type: 'uploaded' as const,
        metadata: result.metadata,
      };
      await writeFile(
        join(BACKUP_DIR, filename.replace('.zip', '.meta.json')),
        JSON.stringify(sidecar, null, 2)
      );

      return { filename, metadata: result.metadata };
    } catch (err) {
      // Clean up on error
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore
      }
      app.log.error({ err }, 'Failed to upload backup');
      return reply.internalServerError('Upload failed');
    }
  });

  /** GET /backup/list — List all backups */
  app.get('/list', { preHandler: [app.requireOwner] }, async (_request, reply) => {
    try {
      return await listBackups();
    } catch (err) {
      app.log.error({ err }, 'Failed to list backups');
      return reply.internalServerError('Failed to list backups');
    }
  });

  /** POST /backup/download-token/:filename — Issue a short-lived download token */
  app.post<{ Params: { filename: string } }>(
    '/download-token/:filename',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const parsed = backupFilenameSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.badRequest('Invalid filename');
      }

      const filePath = join(BACKUP_DIR, parsed.data.filename);
      if (!existsSync(filePath)) {
        return reply.notFound('Backup not found');
      }

      const token = createDownloadToken(parsed.data.filename);
      return { token };
    }
  );

  /** GET /backup/download/:filename — Download a backup (token auth via query param) */
  app.get<{ Params: { filename: string }; Querystring: { token: string } }>(
    '/download/:filename',
    async (request, reply) => {
      const token = (request.query as { token?: string }).token;
      if (!token) {
        return reply.unauthorized('Download token required');
      }

      const filename = consumeDownloadToken(token);
      if (!filename) {
        return reply.unauthorized('Invalid or expired download token');
      }

      // Verify the token was issued for this specific file
      if (filename !== request.params.filename) {
        return reply.forbidden('Token does not match requested file');
      }

      const parsed = backupFilenameSchema.safeParse({ filename });
      if (!parsed.success) {
        return reply.badRequest('Invalid filename');
      }

      const filePath = join(BACKUP_DIR, parsed.data.filename);
      if (!existsSync(filePath)) {
        return reply.notFound('Backup not found');
      }

      const fileStat = await stat(filePath);
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${parsed.data.filename}"`)
        .header('Content-Length', fileStat.size)
        .send(createReadStream(filePath));
    }
  );

  /** DELETE /backup/:filename — Delete a backup */
  app.delete<{ Params: { filename: string } }>(
    '/:filename',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const parsed = backupFilenameSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.badRequest('Invalid filename');
      }

      const zipPath = join(BACKUP_DIR, parsed.data.filename);
      const metaPath = join(BACKUP_DIR, parsed.data.filename.replace('.zip', '.meta.json'));

      if (!existsSync(zipPath)) {
        return reply.notFound('Backup not found');
      }

      try {
        unlinkSync(zipPath);
      } catch {
        // Ignore
      }
      try {
        unlinkSync(metaPath);
      } catch {
        // Ignore
      }

      return { success: true };
    }
  );

  // ==========================================================================
  // Restore
  // ==========================================================================

  /** POST /backup/restore — Start restore from a backup in BACKUP_DIR */
  app.post('/restore', { preHandler: [app.requireOwner] }, async (request, reply) => {
    if (isRestoring()) {
      return reply.conflict('A restore is already in progress');
    }

    // Restore requires superuser for TimescaleDB pre_restore/post_restore and extension operations
    const suResult = await db.execute<{ usesuper: boolean }>(
      sql`SELECT usesuper FROM pg_user WHERE usename = current_user`
    );
    if (!suResult.rows[0]?.usesuper) {
      return reply.forbidden(
        'Restore requires PostgreSQL superuser privileges. ' +
          'The database user does not have sufficient permissions to perform extension operations needed for restore.'
      );
    }

    const parsed = restoreBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`
      );
    }

    const zipPath = join(BACKUP_DIR, parsed.data.filename);
    if (!existsSync(zipPath)) {
      return reply.notFound('Backup file not found');
    }

    // Validate before starting
    const result = await validateBackup(zipPath);
    if (!result.valid || !result.metadata) {
      return reply.badRequest(`Invalid backup: ${result.errors.join(', ')}`);
    }

    // Fire-and-forget — caller polls /health for progress
    void orchestrateRestore(zipPath, app, result.metadata.database.timescaleVersion);

    return { valid: true, metadata: result.metadata };
  });

  // ==========================================================================
  // Backup Schedule
  // ==========================================================================

  /** GET /backup/info — Backup directory info, database size, free space */
  app.get('/info', { preHandler: [app.requireOwner] }, async () => {
    const [sizeResult, fs, superuserResult, pgVersionResult, tsVersionResult] = await Promise.all([
      db.execute<{ size: string }>(sql`SELECT pg_database_size(current_database()) AS size`),
      statfs(BACKUP_DIR),
      db.execute<{ usesuper: boolean }>(
        sql`SELECT usesuper FROM pg_user WHERE usename = current_user`
      ),
      db.execute<{ server_version: string }>(sql`SHOW server_version`),
      db.execute<{ max_version: string }>(
        sql`SELECT version AS max_version FROM pg_available_extension_versions WHERE name = 'timescaledb' ORDER BY string_to_array(version, '.')::int[] DESC LIMIT 1`
      ),
    ]);
    return {
      backupDir: BACKUP_DIR,
      databaseSize: Number(sizeResult.rows[0]?.size ?? 0),
      freeSpace: fs.bfree * fs.bsize,
      canRestore: superuserResult.rows[0]?.usesuper ?? false,
      pgVersion: pgVersionResult.rows[0]?.server_version ?? '',
      timescaleVersion: tsVersionResult.rows[0]?.max_version ?? '',
    };
  });

  /** GET /backup/schedule — Get current schedule settings */
  app.get('/schedule', { preHandler: [app.requireOwner] }, async () => {
    const schedule = await getBackupScheduleSettings();
    return { ...schedule, timezone: process.env.TZ || 'UTC' };
  });

  /** PUT /backup/schedule — Update schedule settings */
  app.put('/schedule', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const parsed = scheduleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`
      );
    }

    const { type, time, dayOfWeek, dayOfMonth, retentionCount } = parsed.data;

    await setSettings({
      backupScheduleType: type,
      backupScheduleTime: time,
      backupScheduleDayOfWeek: dayOfWeek,
      backupScheduleDayOfMonth: dayOfMonth,
      backupRetentionCount: retentionCount,
    });

    // Reschedule the BullMQ repeatable job
    await scheduleBackupJob({ type: type as BackupScheduleType, time, dayOfWeek, dayOfMonth });

    return { success: true };
  });
};
