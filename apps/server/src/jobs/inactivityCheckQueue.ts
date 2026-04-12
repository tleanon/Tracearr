/**
 * Inactivity Check Queue - BullMQ-based periodic account inactivity checking
 *
 * Monitors user accounts for periods of no activity and creates violations
 * when accounts have been inactive for configurable time periods.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix } from '@tracearr/shared';
import type { Redis } from 'ioredis';
import { isMaintenance } from '../serverState.js';
import { eq, and, isNull } from 'drizzle-orm';
import type {
  Rule,
  AccountInactivityParams,
  ViolationWithDetails,
  RuleConditions,
  Operator,
} from '@tracearr/shared';
import { WS_EVENTS, TIME_MS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { rules, serverUsers, violations, users, servers } from '../db/schema.js';
import { ruleEngine } from '../services/rules.js';
import { enqueueNotification } from './notificationQueue.js';

// Queue name
const QUEUE_NAME = 'inactivity-check';

// Fixed check interval (1 hour)
const CHECK_INTERVAL_MS = TIME_MS.HOUR;

// Startup delay before first check (5 minutes) - allows server to fully initialize
const STARTUP_DELAY_MS = 5 * TIME_MS.MINUTE;

// Job types
interface InactivityCheckJobData {
  type: 'check';
  ruleId?: string; // If set, only check this specific rule
}

/**
 * Check if V2 rule conditions contain an inactive_days field.
 */
export function hasInactivityCondition(conditions: RuleConditions | null): boolean {
  if (!conditions?.groups) return false;
  return conditions.groups.some((group) =>
    group.conditions.some((c) => c.field === 'inactive_days')
  );
}

/**
 * Extract the inactive_days threshold and operator from V2 conditions.
 * Returns the value and operator of the first inactive_days condition found, or null.
 */
export function extractInactiveDaysFromConditions(
  conditions: RuleConditions | null
): { value: number; operator: Operator } | null {
  if (!conditions?.groups) return null;
  for (const group of conditions.groups) {
    for (const c of group.conditions) {
      if (c.field === 'inactive_days' && typeof c.value === 'number') {
        return { value: c.value, operator: c.operator };
      }
    }
  }
  return null;
}

// Connection options (set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let inactivityQueue: Queue<InactivityCheckJobData> | null = null;
let inactivityWorker: Worker<InactivityCheckJobData> | null = null;

// Redis client reference (kept for potential future use with caching)
let _redisClient: Redis | null = null;

// Pub/sub service for broadcasting violations
let pubSubPublish: ((event: string, data: unknown) => Promise<void>) | null = null;

/**
 * Initialize the inactivity check queue with Redis connection
 */
export function initInactivityCheckQueue(
  redisUrl: string,
  redis: Redis,
  publishFn: (event: string, data: unknown) => Promise<void>
): void {
  if (inactivityQueue) {
    console.log('[Inactivity] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  _redisClient = redis;
  pubSubPublish = publishFn;
  const bullPrefix = `${getRedisPrefix()}bull`;

  // Create the inactivity check queue
  inactivityQueue = new Queue<InactivityCheckJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000, // 10s, 20s, 40s
      },
      removeOnComplete: {
        count: 50, // Keep last 50 for debugging
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 100,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });
  inactivityQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[Inactivity] Queue error:', err);
  });

  console.log('[Inactivity] Queue initialized');
}

/**
 * Start the inactivity check worker
 */
export function startInactivityCheckWorker(): void {
  if (!connectionOptions) {
    throw new Error('Inactivity check queue not initialized. Call initInactivityCheckQueue first.');
  }

  if (inactivityWorker) {
    console.log('[Inactivity] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  inactivityWorker = new Worker<InactivityCheckJobData>(
    QUEUE_NAME,
    async (job: Job<InactivityCheckJobData>) => {
      const startTime = Date.now();
      try {
        await processInactivityCheck(job);
        const duration = Date.now() - startTime;
        console.log(`[Inactivity] Job ${job.id} completed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[Inactivity] Job ${job.id} failed after ${duration}ms:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1, // Only one check at a time to avoid DB contention
    }
  );

  inactivityWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[Inactivity] Worker error:', error);
  });

  console.log('[Inactivity] Worker started');
}

/**
 * Schedule inactivity checks based on active rules
 * Called on startup and when rules are created/updated/deleted
 */
export async function scheduleInactivityChecks(): Promise<void> {
  if (!inactivityQueue) {
    console.error('[Inactivity] Queue not initialized');
    return;
  }

  // Remove any existing job schedulers
  const schedulers = await inactivityQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.id) {
      await inactivityQueue.removeJobScheduler(scheduler.id);
    }
  }

  // Get all active rules and filter for inactivity conditions in app code
  const candidateRules = await db
    .select({
      id: rules.id,
      conditions: rules.conditions,
    })
    .from(rules)
    .where(eq(rules.isActive, true));

  const activeRules = candidateRules.filter((r) => hasInactivityCondition(r.conditions));

  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules found');
    return;
  }

  // Schedule a single recurring job that checks all rules hourly
  await inactivityQueue.add(
    'scheduled-check',
    { type: 'check' },
    {
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      jobId: 'inactivity-check-repeatable',
    }
  );

  // Schedule a delayed startup check to allow server to fully initialize
  // This prevents false positives during server startup
  await inactivityQueue.add(
    'startup-check',
    { type: 'check' },
    {
      delay: STARTUP_DELAY_MS,
      jobId: `startup-${Date.now()}`,
    }
  );

  console.log(`[Inactivity] Scheduled hourly checks for ${activeRules.length} rule(s)`);
}

/**
 * Trigger an immediate inactivity check for all rules or a specific rule
 */
export async function triggerInactivityCheck(ruleId?: string): Promise<void> {
  if (!inactivityQueue) {
    console.error('[Inactivity] Queue not initialized');
    return;
  }

  await inactivityQueue.add(
    'manual-check',
    { type: 'check', ruleId },
    { jobId: `manual-${Date.now()}` }
  );
}

/**
 * Process an inactivity check job
 */
async function processInactivityCheck(job: Job<InactivityCheckJobData>): Promise<void> {
  console.log(`[Inactivity] Processing check (job ${job.id})`);

  // Get all active rules and filter for inactivity conditions
  const candidateRules = await db
    .select()
    .from(rules)
    .where(job.data.ruleId ? eq(rules.id, job.data.ruleId) : eq(rules.isActive, true));

  const activeRules = candidateRules.filter((r) => hasInactivityCondition(r.conditions));

  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules to check');
    return;
  }

  let totalViolations = 0;

  for (const rule of activeRules) {
    const inactivityCondition = extractInactiveDaysFromConditions(rule.conditions);
    if (inactivityCondition === null) {
      console.warn(
        `[Inactivity] Could not extract inactive_days from rule ${rule.name} (${rule.id}), skipping`
      );
      continue;
    }
    const params: AccountInactivityParams = {
      inactivityValue: inactivityCondition.value,
      inactivityUnit: 'days',
    };
    const { operator } = inactivityCondition;

    console.log(`[Inactivity] Checking rule: ${rule.name} (${rule.id})`);

    // Get users to check based on rule scope (exclude removed users)
    let usersToCheck;
    if (rule.serverUserId) {
      // Per-user rule - only check this specific user (if not removed)
      usersToCheck = await db
        .select({
          id: serverUsers.id,
          username: serverUsers.username,
          lastActivityAt: serverUsers.lastActivityAt,
          serverId: serverUsers.serverId,
        })
        .from(serverUsers)
        .where(and(eq(serverUsers.id, rule.serverUserId), isNull(serverUsers.removedAt)));
    } else {
      // Global rule - check all active users
      usersToCheck = await db
        .select({
          id: serverUsers.id,
          username: serverUsers.username,
          lastActivityAt: serverUsers.lastActivityAt,
          serverId: serverUsers.serverId,
        })
        .from(serverUsers)
        .where(isNull(serverUsers.removedAt));
    }

    console.log(`[Inactivity] Checking ${usersToCheck.length} users for rule ${rule.name}`);

    for (const user of usersToCheck) {
      // Evaluate inactivity for this user
      const result = ruleEngine.evaluateAccountInactivity(user, params, operator);

      if (result.violated) {
        // Only create violation if no existing unacknowledged violation exists
        const shouldCreate = await shouldCreateViolation(user.id, rule.id);

        if (shouldCreate) {
          await createInactivityViolation(rule as unknown as Rule, user, result);
          totalViolations++;
        }
      }
    }
  }

  console.log(`[Inactivity] Check complete. Created ${totalViolations} violations.`);
}

/** Skip if any violation already exists for this user+rule (dismissed ones are deleted, so those won't block) */
async function shouldCreateViolation(serverUserId: string, ruleId: string): Promise<boolean> {
  const existing = await db
    .select({ id: violations.id })
    .from(violations)
    .where(and(eq(violations.serverUserId, serverUserId), eq(violations.ruleId, ruleId)))
    .limit(1);

  return existing.length === 0;
}

/**
 * Create an inactivity violation (no associated session)
 */
async function createInactivityViolation(
  rule: Rule,
  user: { id: string; username: string; serverId: string },
  result: { severity: string; data: Record<string, unknown> }
): Promise<void> {
  // Insert violation without session reference
  const created = await db.transaction(async (tx) => {
    const insertedRows = await tx
      .insert(violations)
      .values({
        ruleId: rule.id,
        serverUserId: user.id,
        sessionId: null, // No session for inactivity violations
        severity: result.severity as 'low' | 'warning' | 'high',
        ruleType: 'account_inactivity',
        data: result.data,
      })
      .onConflictDoNothing()
      .returning();

    return insertedRows[0];
  });

  if (!created) {
    console.log(`[Inactivity] Duplicate violation prevented for user ${user.username}`);
    return;
  }

  // Get user and server details for broadcasting
  const [details] = await db
    .select({
      userId: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      serverId: servers.id,
      serverName: servers.name,
      serverType: servers.type,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(eq(serverUsers.id, user.id))
    .limit(1);

  if (!details) {
    console.warn(`[Inactivity] Could not find details for user ${user.id}`);
    return;
  }

  // Broadcast violation event
  if (pubSubPublish) {
    const violationWithDetails: ViolationWithDetails = {
      id: created.id,
      ruleId: created.ruleId,
      serverUserId: created.serverUserId,
      sessionId: created.sessionId,
      severity: created.severity,
      data: created.data,
      acknowledgedAt: created.acknowledgedAt,
      createdAt: created.createdAt,
      user: {
        id: details.userId,
        username: details.username,
        thumbUrl: details.thumbUrl,
        serverId: details.serverId,
        identityName: details.identityName,
      },
      rule: {
        id: rule.id,
        name: rule.name,
        type: rule.type,
      },
      server: {
        id: details.serverId,
        name: details.serverName,
        type: details.serverType,
      },
    };

    await pubSubPublish(WS_EVENTS.VIOLATION_NEW, violationWithDetails);
    console.log(`[Inactivity] Violation created: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch (Discord, webhooks, push)
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }
}

/**
 * Gracefully shutdown the inactivity check queue and worker
 */
export async function shutdownInactivityCheckQueue(): Promise<void> {
  console.log('[Inactivity] Shutting down queue...');

  if (inactivityWorker) {
    await inactivityWorker.close();
    inactivityWorker = null;
  }

  if (inactivityQueue) {
    await inactivityQueue.close();
    inactivityQueue = null;
  }

  _redisClient = null;
  pubSubPublish = null;

  console.log('[Inactivity] Queue shutdown complete');
}

/**
 * Get the inactivity check queue instance (for testing or external scheduling)
 */
export function getInactivityQueue(): Queue<InactivityCheckJobData> | null {
  return inactivityQueue;
}

/**
 * Get queue statistics for the inactivity check queue
 */
export async function getInactivityCheckQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  schedule: string | null;
} | null> {
  if (!inactivityQueue) return null;

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    inactivityQueue.getWaitingCount(),
    inactivityQueue.getActiveCount(),
    inactivityQueue.getCompletedCount(),
    inactivityQueue.getFailedCount(),
    inactivityQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed, schedule: `every ${CHECK_INTERVAL_MS}ms` };
}
