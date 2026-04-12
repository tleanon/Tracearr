/**
 * Session Processor
 *
 * Core processing logic for the poller:
 * - processServerSessions: Process sessions from a single server
 * - pollServers: Orchestrate polling across all servers
 * - Lifecycle management: start, stop, trigger
 */

import {
  POLLER_CONFIG,
  POLLING_INTERVALS,
  SESSION_LIMITS,
  type ActiveSession,
  type RuleV2,
  type SessionState,
} from '@tracearr/shared';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers, serverUsers, sessions, users } from '../../db/schema.js';
import { getGeoIPSettings } from '../../routes/settings.js';
import { isMaintenance } from '../../serverState.js';
import type { CacheService, PubSubService } from '../../services/cache.js';
import { type GeoLocation } from '../../services/geoip.js';
import { createMediaServerClient } from '../../services/mediaServer/index.js';
import { lookupGeoIP } from '../../services/plexGeoip.js';
import { registerService, unregisterService } from '../../services/serviceTracker.js';
import { sseManager } from '../../services/sseManager.js';

import { enqueueNotification } from '../notificationQueue.js';
import { batchGetRecentUserSessions, getActiveRulesV2 } from './database.js';
import { updatePendingSession } from './pendingConfirmation.js';
import {
  buildActiveSession,
  buildPendingActiveSession,
  createSessionWithRulesAtomic,
  findActiveSession,
  findActiveSessionByComposite,
  handleMediaChangeAtomic,
  processPollResults,
  reEvaluateRulesOnPauseState,
  reEvaluateRulesOnTranscodeChange,
  stopSessionAtomic,
} from './sessionLifecycle.js';
import { mapMediaSession, pickStreamDetailFields } from './sessionMapper.js';
import {
  buildCompositeKey,
  calculatePauseAccumulation,
  checkWatchCompletion,
  detectMediaChange,
  shouldForceStopStaleSession,
  shouldWriteToDb,
} from './stateTracker.js';
import type { PollerConfig, ServerProcessingResult, ServerWithToken } from './types.js';
import { DB_WRITE_FLUSH_INTERVAL_MS } from './types.js';
import { broadcastViolations } from './violations.js';

// ============================================================================
// Module State
// ============================================================================

let pollingInterval: NodeJS.Timeout | null = null;
let staleSweepInterval: NodeJS.Timeout | null = null;
let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;
let previousPollHadSessions = false;
let currentPollIntervalMs: number = POLLING_INTERVALS.SESSIONS_IDLE;

const defaultConfig: PollerConfig = {
  enabled: true,
  intervalMs: POLLING_INTERVALS.SESSIONS_IDLE,
};

// Time bound for active session queries to limit TimescaleDB chunk scanning.
// Active sessions should only exist in recent chunks - anything older would have
// been force-stopped by the stale session sweep. 7 days gives ample buffer.
const ACTIVE_SESSION_CHUNK_BOUND_MS = 7 * 24 * 60 * 60 * 1000;

// Grace period tracking for session stop detection.
// When a session disappears from a poll response, it enters a grace period
// rather than being stopped immediately. This prevents data loss from transient
// API failures (e.g., Emby/Jellyfin returning incomplete session data).
// On first miss: session is removed from cache (UI hides it) but DB is untouched.
// If the session reappears, it's recovered seamlessly with no data loss.
// On the NEXT poll, if still absent, the DB stop is confirmed and notification sent.
// Key: `serverId:sessionKey`, Value: ActiveSession snapshot for notification on confirmed stop.
const missedPollTracking = new Map<string, ActiveSession>();

// Last DB write time per session — for 30s periodic flush.
const lastDbWriteMap = new Map<string, number>();

/**
 * Handle first-miss grace period entries for a set of cached session keys.
 * Sessions that just disappeared from the API response are removed from cache
 * (UI hides them) but NOT stopped in DB. An ActiveSession snapshot is stored
 * in missedPollTracking for notification on confirmed stop.
 */
async function handleFirstMisses(
  cachedKeys: Iterable<string>,
  serverId: string,
  activeSessions: ActiveSession[],
  serverTypeMap: Map<string, string>
): Promise<void> {
  for (const cachedKey of cachedKeys) {
    if (!cachedKey.startsWith(`${serverId}:`)) continue;
    if (missedPollTracking.has(cachedKey)) continue; // Already in grace period

    const cachedActiveSession = activeSessions.find((s) => {
      const sType = (serverTypeMap.get(s.serverId) ?? 'plex') as 'plex' | 'jellyfin' | 'emby';
      return (
        buildCompositeKey({
          serverType: sType,
          serverId: s.serverId,
          externalUserId: s.serverUserId,
          deviceId: s.deviceId ?? null,
          ratingKey: s.ratingKey ?? null,
          sessionKey: s.sessionKey,
        }) === cachedKey
      );
    });
    if (!cachedActiveSession) {
      console.warn(
        `[Poller] Cache mismatch for ${cachedKey}: in cachedSessionKeys but not in activeSessions`
      );
      continue;
    }

    missedPollTracking.set(cachedKey, cachedActiveSession);
    try {
      if (cacheService) {
        await cacheService.removeActiveSession(cachedActiveSession.id);
        await cacheService.removeUserSession(
          cachedActiveSession.serverUserId,
          cachedActiveSession.id
        );
      }
      if (pubSubService) {
        await pubSubService.publish('session:stopped', cachedActiveSession.id);
      }
    } catch (err) {
      console.error(`[Poller] Failed to remove/broadcast grace period stop for ${cachedKey}:`, err);
    }
  }
}

/**
 * Sweep grace period entries that were tracked in a PREVIOUS poll cycle.
 * For each entry still absent, confirm the stop in DB and send notification.
 * Failed entries stay in the map for retry on the next poll.
 */
async function sweepGracePeriod(
  keysToSweep: Set<string>,
  serverId: string,
  serverTypeMap: Map<string, string>,
  currentSessionKeys?: Set<string>
): Promise<void> {
  for (const key of keysToSweep) {
    if (currentSessionKeys?.has(key)) continue; // Reappeared

    try {
      const snapshot = missedPollTracking.get(key);
      if (!snapshot) {
        missedPollTracking.delete(key);
        continue;
      }

      const serverType = serverTypeMap.get(serverId);
      const session =
        serverType && serverType !== 'plex'
          ? await findActiveSessionByComposite({
              serverId,
              serverUserId: snapshot.serverUserId,
              deviceId: snapshot.deviceId || null,
              ratingKey: snapshot.ratingKey ?? '',
            })
          : await findActiveSession({ serverId, sessionKey: snapshot.sessionKey });
      if (session) {
        const { wasUpdated, durationMs, needsRetry, retryData } = await stopSessionAtomic({
          session,
          stoppedAt: new Date(),
        });
        lastDbWriteMap.delete(session.id);
        if (needsRetry && retryData && cacheService) {
          await cacheService.addSessionWriteRetry(session.id, retryData);
        }
        if (wasUpdated) {
          if (snapshot) {
            try {
              await enqueueNotification({
                type: 'session_stopped',
                payload: { ...snapshot, durationMs },
              });
            } catch (notifErr) {
              console.error(`[Poller] Failed to enqueue stop notification for ${key}:`, notifErr);
            }
          }
        }
      } else {
        console.log(`[Poller] Grace period: session for ${key} already stopped by another process`);
      }
    } catch (err) {
      console.error(`[Poller] Grace period sweep failed for ${key}, will retry next poll:`, err);
      continue;
    }
    missedPollTracking.delete(key);
  }
}

// ============================================================================
// Server Session Processing
// ============================================================================

/**
 * Process a single server's sessions
 *
 * This function:
 * 1. Fetches current sessions from the media server
 * 2. Creates/updates users as needed
 * 3. Creates new session records for new playbacks
 * 4. Updates existing sessions with state changes
 * 5. Marks stopped sessions as stopped
 * 6. Evaluates rules and creates violations
 *
 * @param server - Server to poll
 * @param activeRules - Active rules for evaluation
 * @param cachedSessionKeys - Set of currently cached session keys
 * @returns Processing results (new, updated, stopped sessions)
 */
async function processServerSessions(
  server: ServerWithToken,
  activeRulesV2: RuleV2[],
  cachedSessionKeys: Set<string>,
  activeSessions: ActiveSession[] = []
): Promise<ServerProcessingResult> {
  const newSessions: ActiveSession[] = [];
  const updatedSessions: ActiveSession[] = [];
  const currentSessionKeys = new Set<string>();

  // Get GeoIP settings once at the start
  const { usePlexGeoip } = await getGeoIPSettings();

  try {
    // Fetch sessions from server using unified adapter
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
    });
    const mediaSessions = await client.getSessions();
    const processedSessions = mediaSessions.map((s) => mapMediaSession(s, server.type));

    // OPTIMIZATION: Early return if no active sessions from media server
    if (processedSessions.length === 0) {
      // Snapshot keys already in grace period BEFORE adding new entries
      const keysToSweep = new Set(
        [...missedPollTracking.keys()].filter((k) => k.startsWith(`${server.id}:`))
      );
      const sTypeMap = new Map([[server.id, server.type]]);
      await handleFirstMisses(cachedSessionKeys, server.id, activeSessions, sTypeMap);
      await sweepGracePeriod(keysToSweep, server.id, sTypeMap);

      // stoppedSessionKeys intentionally empty
      return { success: true, newSessions: [], stoppedSessionKeys: [], updatedSessions: [] };
    }

    // OPTIMIZATION: Only load server users that match active sessions (not all users for server)
    // Collect unique externalIds from current sessions
    const sessionExternalIds = [...new Set(processedSessions.map((s) => s.externalUserId))];

    const serverUsersList = await db
      .select({
        id: serverUsers.id,
        userId: serverUsers.userId,
        serverId: serverUsers.serverId,
        externalId: serverUsers.externalId,
        username: serverUsers.username,
        email: serverUsers.email,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        trustScore: serverUsers.trustScore,
        sessionCount: serverUsers.sessionCount,
        lastActivityAt: serverUsers.lastActivityAt,
        createdAt: serverUsers.createdAt,
        updatedAt: serverUsers.updatedAt,
        identityName: users.name,
      })
      .from(serverUsers)
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(
        and(
          eq(serverUsers.serverId, server.id),
          inArray(serverUsers.externalId, sessionExternalIds)
        )
      );

    // Build server user caches: externalId -> serverUser and id -> serverUser
    const serverUserByExternalId = new Map<string, (typeof serverUsersList)[0]>();
    const serverUserById = new Map<string, (typeof serverUsersList)[0]>();
    for (const serverUser of serverUsersList) {
      if (serverUser.externalId) {
        serverUserByExternalId.set(serverUser.externalId, serverUser);
      }
      serverUserById.set(serverUser.id, serverUser);
    }

    // Track server users that need to be created and their session indices
    const serverUsersToCreate: {
      externalId: string;
      username: string;
      thumbUrl: string | null;
      sessionIndex: number;
    }[] = [];

    // First pass: identify server users and resolve from cache or mark for creation
    const sessionServerUserIds: (string | null)[] = [];

    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const existingServerUser = serverUserByExternalId.get(processed.externalUserId);

      if (existingServerUser) {
        // Check if server user data needs update
        const needsUpdate =
          existingServerUser.username !== processed.username ||
          (processed.userThumb && existingServerUser.thumbUrl !== processed.userThumb);

        if (needsUpdate) {
          await db
            .update(serverUsers)
            .set({
              username: processed.username,
              thumbUrl: processed.userThumb || existingServerUser.thumbUrl,
              updatedAt: new Date(),
            })
            .where(eq(serverUsers.id, existingServerUser.id));

          // Update cache
          existingServerUser.username = processed.username;
          if (processed.userThumb) existingServerUser.thumbUrl = processed.userThumb;
        }

        sessionServerUserIds.push(existingServerUser.id);
      } else {
        // Need to create server user - mark for batch creation
        serverUsersToCreate.push({
          externalId: processed.externalUserId,
          username: processed.username,
          thumbUrl: processed.userThumb || null,
          sessionIndex: i,
        });
        sessionServerUserIds.push(null); // Will be filled after creation
      }
    }

    // Batch create new server users (and their identity users)
    // Wrapped in transaction to prevent orphan identity users if server user insert fails
    if (serverUsersToCreate.length > 0) {
      const { newIdentityUsers, newServerUsers } = await db.transaction(async (tx) => {
        // First, create identity users for each new server user
        const identityUsers = await tx
          .insert(users)
          .values(
            serverUsersToCreate.map((u) => ({
              username: u.username, // Login identifier
              name: u.username, // Use username as initial display name
              thumbnail: u.thumbUrl,
            }))
          )
          .returning();

        // Then create server users linked to the identity users
        const serverUserRows = await tx
          .insert(serverUsers)
          .values(
            serverUsersToCreate.map((u, idx) => ({
              userId: identityUsers[idx]!.id,
              serverId: server.id,
              externalId: u.externalId,
              username: u.username,
              thumbUrl: u.thumbUrl,
            }))
          )
          .returning();

        return { newIdentityUsers: identityUsers, newServerUsers: serverUserRows };
      });

      // Update sessionServerUserIds with newly created server user IDs
      for (let i = 0; i < serverUsersToCreate.length; i++) {
        const serverUserToCreate = serverUsersToCreate[i]!;
        const newServerUser = newServerUsers[i];
        const newIdentityUser = newIdentityUsers[i];
        if (newServerUser && newIdentityUser) {
          sessionServerUserIds[serverUserToCreate.sessionIndex] = newServerUser.id;
          // Add to cache with identityName from the identity user
          const serverUserWithIdentity = {
            ...newServerUser,
            identityName: newIdentityUser.name,
          };
          serverUserById.set(newServerUser.id, serverUserWithIdentity);
          serverUserByExternalId.set(serverUserToCreate.externalId, serverUserWithIdentity);
        }
      }
    }

    // OPTIMIZATION: Batch load recent sessions for rule evaluation
    // Only load for server users with new sessions (not cached)
    const serverUsersWithNewSessions = new Set<string>();
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const serverUserId = sessionServerUserIds[i];
      // serverUserId must match what pollServers uses from cachedSessions
      const sessionKey = buildCompositeKey({
        serverType: server.type,
        serverId: server.id,
        externalUserId: serverUserId ?? processed.externalUserId,
        deviceId: processed.deviceId,
        ratingKey: processed.ratingKey,
        sessionKey: processed.sessionKey,
      });
      const isNew = !cachedSessionKeys.has(sessionKey);
      if (isNew && serverUserId) {
        serverUsersWithNewSessions.add(serverUserId);
      }
    }

    const recentSessionsMap = await batchGetRecentUserSessions([...serverUsersWithNewSessions]);

    // Process each session
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const serverUserId = sessionServerUserIds[i];
      const sessionKey = buildCompositeKey({
        serverType: server.type,
        serverId: server.id,
        externalUserId: serverUserId ?? processed.externalUserId,
        deviceId: processed.deviceId,
        ratingKey: processed.ratingKey,
        sessionKey: processed.sessionKey,
      });
      currentSessionKeys.add(sessionKey);
      if (!serverUserId) {
        console.error('Failed to get/create server user for session');
        continue;
      }

      // Get server user details from cache
      const serverUserFromCache = serverUserById.get(serverUserId);
      const userDetail = serverUserFromCache
        ? {
            id: serverUserFromCache.id,
            username: serverUserFromCache.username,
            thumbUrl: serverUserFromCache.thumbUrl,
            identityName: serverUserFromCache.identityName,
            trustScore: serverUserFromCache.trustScore,
            sessionCount: serverUserFromCache.sessionCount,
            lastActivityAt: serverUserFromCache.lastActivityAt,
            createdAt: serverUserFromCache.createdAt,
          }
        : {
            id: serverUserId,
            username: 'Unknown',
            thumbUrl: null,
            identityName: null,
            trustScore: 100,
            sessionCount: 0,
            lastActivityAt: null,
            createdAt: new Date(), // Brand new users genuinely have 0-day account age
          };

      // Get GeoIP location (uses Plex API if enabled, falls back to MaxMind)
      const geo: GeoLocation = await lookupGeoIP(processed.ipAddress, usePlexGeoip);

      const isNew = !cachedSessionKeys.has(sessionKey);

      if (isNew) {
        // Distributed lock prevents race condition with SSE
        if (!cacheService) {
          console.warn('[Poller] Cache service not available, skipping session creation');
          continue;
        }

        const recentSessions = recentSessionsMap.get(serverUserId) ?? [];

        const createResult = await cacheService.withSessionCreateLock(
          server.id,
          processed.sessionKey,
          async () => {
            const existingWithSameKey = await findActiveSession({
              serverId: server.id,
              sessionKey: processed.sessionKey,
              ratingKey: processed.ratingKey,
            });

            if (existingWithSameKey) {
              cachedSessionKeys.add(sessionKey);
              // Clear any grace period tracking — session is confirmed active
              missedPollTracking.delete(sessionKey);
              console.log(`[Poller] Recovering active session ${processed.sessionKey} into cache`);
              // Return the existing session for cache recovery instead of null
              return { rediscovered: existingWithSameKey };
            }

            // Check if this session was recently terminated (cooldown prevents re-creation)
            if (cacheService && processed.ratingKey) {
              const hasCooldown =
                server.type === 'plex'
                  ? await cacheService.hasTerminationCooldown(
                      server.id,
                      processed.sessionKey,
                      processed.ratingKey
                    )
                  : await cacheService.hasTerminationCooldownComposite(
                      server.id,
                      userDetail.id,
                      processed.deviceId || processed.sessionKey,
                      processed.ratingKey
                    );
              if (hasCooldown) {
                console.log(
                  `[Poller] Session ${processed.sessionKey} was recently terminated, skipping create`
                );
                return null;
              }
            }

            // Duplicate check: Plex-only (JF/Emby use composite keys)
            if (server.type === 'plex' && processed.ratingKey && userDetail?.id) {
              const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

              const [existingForContent] = await db
                .select({ id: sessions.id, sessionKey: sessions.sessionKey })
                .from(sessions)
                .where(
                  and(
                    eq(sessions.serverUserId, userDetail.id),
                    eq(sessions.ratingKey, processed.ratingKey),
                    isNull(sessions.stoppedAt),
                    gte(sessions.startedAt, chunkBound)
                  )
                )
                .limit(1);

              if (existingForContent) {
                console.log(
                  `[Poller] Session_key ${processed.sessionKey} is new, but active session ${existingForContent.id} exists for same content (key: ${existingForContent.sessionKey}). Skipping duplicate.`
                );
                // Add both session keys to cache
                cachedSessionKeys.add(sessionKey);
                cachedSessionKeys.add(`${server.id}:${existingForContent.sessionKey}`);
                return null;
              }
            }

            const result = await createSessionWithRulesAtomic({
              processed,
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: userDetail,
              geo,
              activeRulesV2,
              activeSessions,
              recentSessions,
            });

            if (result.qualityChange) {
              const { stoppedSession } = result.qualityChange;

              if (cacheService) {
                await cacheService.removeActiveSession(stoppedSession.id);
                await cacheService.removeUserSession(
                  stoppedSession.serverUserId,
                  stoppedSession.id
                );
              }

              if (pubSubService) {
                await pubSubService.publish('session:stopped', stoppedSession.id);
              }

              // Prevent "stale" detection for this session
              const stoppedKey = buildCompositeKey({
                serverType: server.type,
                serverId: server.id,
                externalUserId: stoppedSession.serverUserId,
                deviceId: stoppedSession.deviceId,
                ratingKey: stoppedSession.ratingKey,
                sessionKey: stoppedSession.sessionKey,
              });
              cachedSessionKeys.delete(stoppedKey);
            }

            return {
              insertedSession: result.insertedSession,
              violationResults: result.violationResults,
              wasTerminatedByRule: result.wasTerminatedByRule,
            };
          }
        );

        if (!createResult) {
          continue;
        }

        // Handle rediscovered session — existing active session found in DB but missing from cache.
        // This happens on server restart or after a grace period recovery.
        if ('rediscovered' in createResult && createResult.rediscovered) {
          const existing = createResult.rediscovered;
          try {
            // Update lastSeenAt so sweepStaleSessions doesn't kill it
            await db
              .update(sessions)
              .set({ lastSeenAt: new Date() })
              .where(eq(sessions.id, existing.id));
            const activeSession = buildActiveSession({
              session: existing,
              processed,
              user: userDetail,
              geo,
              server,
              overrides: {
                state: processed.state,
                lastPausedAt: existing.lastPausedAt,
                pausedDurationMs: existing.pausedDurationMs ?? 0,
                watched: existing.watched ?? false,
              },
            });
            updatedSessions.push(activeSession);
          } catch (err) {
            console.error(`[Poller] Failed to recover rediscovered session ${existing.id}:`, err);
          }
          continue;
        }

        // Guard: rediscovered returned but session was null
        if ('rediscovered' in createResult) {
          console.error(
            `[Poller] Unexpected null rediscovered session for ${processed.sessionKey}`
          );
          continue;
        }

        const { insertedSession, violationResults, wasTerminatedByRule } = createResult;

        // The termination service already removed from cache (no-op since not added yet)
        // and set cooldown, but we must not add it to newSessions
        if (wasTerminatedByRule) {
          console.log(
            `[Poller] Session ${processed.sessionKey} was terminated by rule, skipping cache add`
          );
          // Still broadcast violations since they were created
          try {
            await broadcastViolations(violationResults, insertedSession.id, pubSubService);
          } catch (err) {
            console.error('[Poller] Failed to broadcast violations:', err);
          }
          continue;
        }

        const activeSession = buildActiveSession({
          session: insertedSession,
          processed,
          user: userDetail,
          geo,
          server,
        });

        newSessions.push(activeSession);
        lastDbWriteMap.set(insertedSession.id, Date.now());

        // Broadcast violations AFTER transaction commits (outside transaction)
        // Wrapped in try-catch to prevent broadcast failures from crashing the poller
        try {
          await broadcastViolations(violationResults, insertedSession.id, pubSubService);
        } catch (err) {
          console.error('[Poller] Failed to broadcast violations:', err);
          // Violations are already persisted in DB, broadcast failure is non-fatal
        }
      } else {
        // Pending session check (cache-first for JF/Emby, SSE for Plex)
        if (cacheService) {
          const pendingKey = server.type === 'plex' ? processed.sessionKey : sessionKey;
          const pendingSession = await cacheService.getPendingSession(server.id, pendingKey);
          if (pendingSession) {
            const { updatedData, isConfirmed } = updatePendingSession(
              pendingSession,
              processed.state,
              processed.progressMs,
              Date.now()
            );

            if (isConfirmed) {
              const recentSessions = recentSessionsMap.get(serverUserId) ?? [];
              const createResult = await cacheService.withSessionCreateLock(
                server.id,
                processed.sessionKey,
                async () =>
                  createSessionWithRulesAtomic({
                    processed,
                    server: { id: server.id, name: server.name, type: server.type },
                    serverUser: userDetail,
                    geo,
                    activeRulesV2,
                    activeSessions,
                    recentSessions,
                    preGeneratedId: updatedData.id,
                  })
              );
              if (createResult && 'insertedSession' in createResult) {
                await cacheService.deletePendingSession(server.id, pendingKey);
                const { insertedSession, violationResults, wasTerminatedByRule } = createResult;
                if (!wasTerminatedByRule) {
                  const activeSession = buildActiveSession({
                    session: insertedSession,
                    processed,
                    user: userDetail,
                    geo,
                    server,
                  });
                  newSessions.push(activeSession);
                  lastDbWriteMap.set(insertedSession.id, Date.now());
                }
                if (violationResults.length > 0 && pubSubService) {
                  try {
                    await broadcastViolations(violationResults, insertedSession.id, pubSubService);
                  } catch (err) {
                    console.error('[Poller] Failed to broadcast violations:', err);
                  }
                }
              }
            } else {
              await cacheService.setPendingSession(server.id, pendingKey, updatedData);
              const activeSession = buildPendingActiveSession(updatedData);
              updatedSessions.push(activeSession);
            }
            continue;
          }
        }

        // Get existing ACTIVE session to check for state changes
        const existingSession =
          server.type === 'plex'
            ? await findActiveSession({
                serverId: server.id,
                sessionKey: processed.sessionKey,
                ratingKey: processed.ratingKey,
              })
            : await findActiveSessionByComposite({
                serverId: server.id,
                serverUserId: userDetail.id,
                deviceId: processed.deviceId || null,
                ratingKey: processed.ratingKey ?? '',
              });
        if (!existingSession) {
          // Issue #120: Stale cache entry - session key is in Redis but no active session exists in DB
          // Remove stale cache entry and create session with proper locking to prevent duplicates.
          console.log(
            `[Poller] Stale cache detected for ${processed.sessionKey} - removing from cache`
          );
          cachedSessionKeys.delete(sessionKey);

          // Use distributed lock to prevent race condition with SSE
          if (!cacheService) {
            console.warn('[Poller] Cache service not available, skipping stale session recovery');
            continue;
          }

          let recentSessions = recentSessionsMap.get(serverUserId);
          if (!recentSessions && serverUserId) {
            const recentForUser = await batchGetRecentUserSessions([serverUserId]);
            recentSessions = recentForUser.get(serverUserId) ?? [];
            recentSessionsMap.set(serverUserId, recentSessions);
          }
          recentSessions = recentSessions ?? [];

          const createResult = await cacheService.withSessionCreateLock(
            server.id,
            processed.sessionKey,
            async () => {
              // Double-check inside lock - SSE might have created it
              const existingWithSameKey = await findActiveSession({
                serverId: server.id,
                sessionKey: processed.sessionKey,
                ratingKey: processed.ratingKey,
              });
              if (existingWithSameKey) {
                cachedSessionKeys.add(sessionKey);
                console.log(
                  `[Poller] Session created by SSE for ${processed.sessionKey}, skipping`
                );
                return null;
              }

              // Check if this session was recently terminated (cooldown prevents re-creation)
              if (processed.ratingKey) {
                const hasCooldown =
                  server.type === 'plex'
                    ? await cacheService!.hasTerminationCooldown(
                        server.id,
                        processed.sessionKey,
                        processed.ratingKey
                      )
                    : await cacheService!.hasTerminationCooldownComposite(
                        server.id,
                        userDetail.id,
                        processed.deviceId || processed.sessionKey,
                        processed.ratingKey
                      );
                if (hasCooldown) {
                  console.log(
                    `[Poller] Session ${processed.sessionKey} was recently terminated, skipping stale recovery`
                  );
                  return null;
                }
              }

              // Issue #121: Plex-only duplicate check for session key reassignment.
              if (server.type === 'plex' && processed.ratingKey && userDetail?.id) {
                // Time bound reduces TimescaleDB chunk scanning
                const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

                const [existingForContent] = await db
                  .select({ id: sessions.id, sessionKey: sessions.sessionKey })
                  .from(sessions)
                  .where(
                    and(
                      eq(sessions.serverUserId, userDetail.id),
                      eq(sessions.ratingKey, processed.ratingKey),
                      isNull(sessions.stoppedAt),
                      gte(sessions.startedAt, chunkBound)
                    )
                  )
                  .limit(1);

                if (existingForContent) {
                  console.log(
                    `[Poller] Stale session_key ${processed.sessionKey} but active session ${existingForContent.id} exists for same content (key: ${existingForContent.sessionKey}). Skipping duplicate creation.`
                  );
                  // Add both session keys to cache to prevent future stale detection
                  cachedSessionKeys.add(sessionKey);
                  cachedSessionKeys.add(`${server.id}:${existingForContent.sessionKey}`);
                  return null;
                }
              }

              return createSessionWithRulesAtomic({
                processed,
                server: { id: server.id, name: server.name, type: server.type },
                serverUser: userDetail,
                geo,
                activeRulesV2,
                activeSessions,
                recentSessions,
              });
            }
          );

          if (createResult) {
            const { insertedSession, violationResults, wasTerminatedByRule } = createResult;

            if (wasTerminatedByRule) {
              console.log(
                `[Poller] Stale recovery session ${processed.sessionKey} was terminated by rule, skipping cache add`
              );
              try {
                await broadcastViolations(violationResults, insertedSession.id, pubSubService);
              } catch (err) {
                console.error('[Poller] Failed to broadcast violations:', err);
              }
              continue;
            }

            const activeSession = buildActiveSession({
              session: insertedSession,
              processed,
              user: userDetail,
              geo,
              server,
            });
            newSessions.push(activeSession);
            lastDbWriteMap.set(insertedSession.id, Date.now());
            cachedSessionKeys.add(sessionKey);

            try {
              await broadcastViolations(violationResults, insertedSession.id, pubSubService);
            } catch (err) {
              console.error('[Poller] Failed to broadcast violations:', err);
            }
          }
          continue;
        }

        // Issue #57: Plex-only media change detection (e.g. "Play Next Episode").
        if (
          server.type === 'plex' &&
          detectMediaChange(existingSession.ratingKey, processed.ratingKey)
        ) {
          const recentSessions = recentSessionsMap.get(serverUserId) ?? [];

          const mediaChangeResult = await handleMediaChangeAtomic({
            existingSession,
            processed,
            server: { id: server.id, name: server.name, type: server.type },
            serverUser: userDetail,
            geo,
            activeRulesV2,
            activeSessions,
            recentSessions,
          });

          if (mediaChangeResult) {
            const { stoppedSession, insertedSession, violationResults, wasTerminatedByRule } =
              mediaChangeResult;

            lastDbWriteMap.delete(stoppedSession.id);
            if (cacheService) {
              await cacheService.removeActiveSession(stoppedSession.id);
              await cacheService.removeUserSession(stoppedSession.serverUserId, stoppedSession.id);
            }
            if (pubSubService) {
              await pubSubService.publish('session:stopped', stoppedSession.id);
            }

            // Broadcast violations for new session
            try {
              await broadcastViolations(violationResults, insertedSession.id, pubSubService);
            } catch (err) {
              console.error('[Poller] Failed to broadcast violations:', err);
            }

            if (wasTerminatedByRule) {
              console.log(
                `[Poller] Media change session ${processed.sessionKey} was terminated by rule, skipping cache add`
              );
              continue;
            }

            const activeSession = buildActiveSession({
              session: insertedSession,
              processed,
              user: userDetail,
              geo,
              server,
            });
            newSessions.push(activeSession);
            lastDbWriteMap.set(insertedSession.id, Date.now());
            cachedSessionKeys.add(sessionKey);
          }

          continue; // Skip normal update path
        }

        const previousState = existingSession.state;
        const newState = processed.state;
        const now = new Date();

        // Check if transcode state changed (e.g., user changed quality mid-stream)
        // If so, we need to update stream details which contain output dimensions
        const transcodeStateChanged =
          existingSession.videoDecision !== processed.videoDecision ||
          existingSession.audioDecision !== processed.audioDecision;

        // JF/Emby: session.Id changed (restart)
        if (server.type !== 'plex' && existingSession.sessionKey !== processed.sessionKey) {
          console.log(
            `[Poller] [${server.type.toUpperCase()}] Session ${sessionKey} session.Id changed: ${existingSession.sessionKey} → ${processed.sessionKey}`
          );
        }

        // Build base update payload
        const updatePayload: Partial<typeof sessions.$inferInsert> = {
          state: newState,
          quality: processed.quality,
          bitrate: processed.bitrate,
          progressMs: processed.progressMs || null,
          lastSeenAt: now,
          plexSessionId: processed.plexSessionId || null,
          isTranscode: processed.isTranscode,
          videoDecision: processed.videoDecision,
          audioDecision: processed.audioDecision,
          // Update sessionKey if session.Id changed on restart
          ...(existingSession.sessionKey !== processed.sessionKey && {
            sessionKey: processed.sessionKey,
          }),
        };

        // Update stream details when valid (skip if API returned incomplete data)
        if (processed.sourceAudioCodec || processed.sourceVideoCodec) {
          Object.assign(updatePayload, pickStreamDetailFields(processed));
        }

        // If transcode state changed, re-evaluate rules that have transcode-related conditions
        if (transcodeStateChanged) {
          // Re-evaluate V2 rules that have transcode-related conditions.
          // At session creation, transcode state might not be known yet (especially Plex SSE),
          // so rules like "block 4K transcoding" need a second chance when transcode starts.
          if (activeRulesV2.length > 0) {
            try {
              const recentSessions = recentSessionsMap.get(serverUserId) ?? [];
              const violationResults = await reEvaluateRulesOnTranscodeChange({
                existingSession,
                processed,
                server: { id: server.id, name: server.name, type: server.type },
                serverUser: userDetail,
                activeRulesV2,
                activeSessions,
                recentSessions,
              });

              if (violationResults.length > 0 && pubSubService) {
                await broadcastViolations(violationResults, existingSession.id, pubSubService);
              }
            } catch (error) {
              console.error(
                `[Poller] Error re-evaluating rules on transcode change for session ${existingSession.id}:`,
                error
              );
            }
          }
        }

        const pauseResult = calculatePauseAccumulation(
          previousState as SessionState,
          newState,
          {
            lastPausedAt: existingSession.lastPausedAt,
            pausedDurationMs: existingSession.pausedDurationMs || 0,
          },
          now
        );
        updatePayload.lastPausedAt = pauseResult.lastPausedAt;
        updatePayload.pausedDurationMs = pauseResult.pausedDurationMs;

        // Check for watch completion
        if (!existingSession.watched && processed.totalDurationMs) {
          const elapsedMs = now.getTime() - existingSession.startedAt.getTime();
          // Account for accumulated pauses and any ongoing pause
          const ongoingPauseMs = pauseResult.lastPausedAt
            ? now.getTime() - pauseResult.lastPausedAt.getTime()
            : 0;
          const currentWatchTimeMs = Math.max(
            0,
            elapsedMs - pauseResult.pausedDurationMs - ongoingPauseMs
          );
          if (
            checkWatchCompletion(
              currentWatchTimeMs,
              processed.progressMs,
              processed.totalDurationMs
            )
          ) {
            updatePayload.watched = true;
          }
        }

        // Write to DB only on state changes or every 30s
        const watchedThresholdReached = updatePayload.watched === true;
        const hasChanges = shouldWriteToDb(existingSession, processed, watchedThresholdReached);
        const lastWrite = lastDbWriteMap.get(existingSession.id) ?? 0;
        const flushElapsed = now.getTime() - lastWrite >= DB_WRITE_FLUSH_INTERVAL_MS;

        if (hasChanges || flushElapsed) {
          await db.update(sessions).set(updatePayload).where(eq(sessions.id, existingSession.id));
          lastDbWriteMap.set(existingSession.id, now.getTime());
        }

        if (newState === 'paused' && activeRulesV2.length > 0) {
          try {
            const recentSessions = recentSessionsMap.get(serverUserId) ?? [];
            const violationResults = await reEvaluateRulesOnPauseState({
              existingSession,
              processed,
              pauseData: {
                lastPausedAt: pauseResult.lastPausedAt,
                pausedDurationMs: pauseResult.pausedDurationMs,
              },
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: userDetail,
              activeRulesV2,
              activeSessions,
              recentSessions,
            });

            if (violationResults.length > 0 && pubSubService) {
              await broadcastViolations(violationResults, existingSession.id, pubSubService);
            }
          } catch (error) {
            console.error(
              `[Poller] Error re-evaluating pause rules for session ${existingSession.id}:`,
              error
            );
          }
        }

        // Build active session for cache/broadcast (with updated pause tracking values)
        const activeSession = buildActiveSession({
          session: existingSession,
          processed,
          user: userDetail,
          geo,
          server,
          overrides: {
            state: newState,
            lastPausedAt: updatePayload.lastPausedAt ?? existingSession.lastPausedAt,
            pausedDurationMs:
              updatePayload.pausedDurationMs ?? existingSession.pausedDurationMs ?? 0,
            watched: updatePayload.watched ?? existingSession.watched ?? false,
          },
        });
        updatedSessions.push(activeSession);
      }
    }

    // Clear grace period tracking for sessions that are present in this poll
    for (const key of currentSessionKeys) {
      if (missedPollTracking.delete(key)) {
        console.log(`[Poller] Session ${key} reappeared after grace period miss, recovered`);
      }
    }

    // Snapshot keys already in grace period BEFORE adding new entries (sweep only processes previous polls).
    // Filter to only keys absent from current poll (keys in currentSessionKeys were already cleared above).
    const keysToSweep = new Set(
      [...missedPollTracking.keys()].filter((k) => k.startsWith(`${server.id}:`))
    );
    const sTypeMap = new Map([[server.id, server.type]]);
    await handleFirstMisses(
      [...cachedSessionKeys].filter(
        (k) => k.startsWith(`${server.id}:`) && !currentSessionKeys.has(k)
      ),
      server.id,
      activeSessions,
      sTypeMap
    );
    await sweepGracePeriod(keysToSweep, server.id, sTypeMap, currentSessionKeys);

    // stoppedSessionKeys intentionally empty — grace period handles stops inline.
    // processPollResults still processes newSessions and updatedSessions normally.
    return { success: true, newSessions, stoppedSessionKeys: [], updatedSessions };
  } catch (error) {
    console.error(`Error polling server ${server.name}:`, error);
    return { success: false, newSessions: [], stoppedSessionKeys: [], updatedSessions: [] };
  }
}

// ============================================================================
// Main Polling Orchestration
// ============================================================================

/**
 * Poll all connected servers for active sessions
 *
 * With SSE integration:
 * - Plex servers with active SSE connections are skipped (handled by SSE)
 * - Plex servers in fallback mode are polled
 * - Jellyfin/Emby servers are always polled (no SSE support)
 */
async function pollServers(): Promise<void> {
  // Bail out if maintenance mode was activated while we were queued.
  // stopPoller() clears the interval but can't abort an in-flight call.
  if (isMaintenance()) return;

  try {
    // Get all connected servers
    const allServers = await db.select().from(servers);

    if (allServers.length === 0) {
      return;
    }

    // Filter to only servers that need polling
    // SSE-connected Plex servers are handled by SSE, not polling
    const serversNeedingPoll = allServers.filter((server) => {
      // Non-Plex servers always need polling (Jellyfin/Emby don't support SSE yet)
      if (server.type !== 'plex') {
        return true;
      }
      // Plex servers in fallback mode need polling
      return sseManager.isInFallback(server.id);
    });

    if (serversNeedingPoll.length === 0) {
      // All Plex servers are connected via SSE, no polling needed
      return;
    }

    // Get cached session keys from atomic SET-based cache
    const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];

    const serverTypeMap = new Map(allServers.map((s) => [s.id, s.type]));

    // Plex: serverId:sessionKey, JF/Emby: composite key
    const cachedSessionKeys = new Set(
      cachedSessions.map((s) => {
        const sType = serverTypeMap.get(s.serverId);
        if (sType && sType !== 'plex') {
          return buildCompositeKey({
            serverType: sType,
            serverId: s.serverId,
            externalUserId: s.serverUserId,
            deviceId: s.deviceId ?? null,
            ratingKey: s.ratingKey ?? null,
            sessionKey: s.sessionKey,
          });
        }
        return `${s.serverId}:${s.sessionKey}`;
      })
    );

    // Get active V2 rules
    const activeRulesV2 = await getActiveRulesV2();

    // Collect results from all servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedKeys: string[] = [];
    const allUpdatedSessions: ActiveSession[] = [];

    // Process each server with health tracking
    for (const server of serversNeedingPoll) {
      const serverWithToken = server as ServerWithToken;

      // Get previous health state for transition detection
      const wasHealthy = cacheService ? await cacheService.getServerHealth(server.id) : null;

      const { success, newSessions, stoppedSessionKeys, updatedSessions } =
        await processServerSessions(
          serverWithToken,
          activeRulesV2,
          cachedSessionKeys,
          cachedSessions
        );

      // Track health state and notify on transitions (with consecutive-failure threshold)
      if (cacheService) {
        if (success) {
          const wasDown = wasHealthy === false;
          await cacheService.setServerHealth(server.id, true);
          await cacheService.resetServerFailCount(server.id);

          if (wasDown) {
            console.log(`[Poller] Server ${server.name} is back UP`);
            await enqueueNotification({
              type: 'server_up',
              payload: { serverName: server.name, serverId: server.id },
            });
          }
        } else {
          const failCount = await cacheService.incrServerFailCount(server.id);

          if (failCount >= POLLER_CONFIG.DOWN_THRESHOLD) {
            await cacheService.setServerHealth(server.id, false);

            if (wasHealthy !== false) {
              console.log(
                `[Poller] Server ${server.name} is DOWN (${failCount} consecutive failures)`
              );
              await enqueueNotification({
                type: 'server_down',
                payload: { serverName: server.name, serverId: server.id },
              });
            }
          }
        }
      }

      allNewSessions.push(...newSessions);
      allStoppedKeys.push(...stoppedSessionKeys);
      allUpdatedSessions.push(...updatedSessions);
    }

    await processPollResults({
      newSessions: allNewSessions,
      stoppedKeys: allStoppedKeys,
      updatedSessions: allUpdatedSessions,
      cachedSessions,
      cacheService,
      pubSubService,
      enqueueNotification,
    });

    if (allNewSessions.length > 0 || allStoppedKeys.length > 0) {
      console.log(
        `Poll complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedKeys.length} stopped`
      );
    }

    // Adaptive polling
    const hasActiveSessions =
      allNewSessions.length > 0 ||
      allUpdatedSessions.length > 0 ||
      cachedSessions.length > allStoppedKeys.length;

    if (hasActiveSessions !== previousPollHadSessions && pollingInterval) {
      const newInterval = hasActiveSessions
        ? POLLING_INTERVALS.SESSIONS_ACTIVE
        : POLLING_INTERVALS.SESSIONS_IDLE;

      if (newInterval !== currentPollIntervalMs) {
        clearInterval(pollingInterval);
        pollingInterval = setInterval(() => void pollServers(), newInterval);
        currentPollIntervalMs = newInterval;
        console.log(
          `[Poller] Adaptive: switched to ${newInterval}ms (${hasActiveSessions ? 'active' : 'idle'})`
        );
      }
    }
    previousPollHadSessions = hasActiveSessions;

    // Sweep for stale sessions that haven't been seen in a while
    // This catches sessions where server went down or SSE missed the stop event
    await sweepStaleSessions();
  } catch (error) {
    // Suppress DB errors during maintenance — the in-flight poll was already
    // running when the DB went down and stopPoller() can't abort an active await.
    if (!isMaintenance()) {
      console.error('Polling error:', error);
    }
  }
}

// ============================================================================
// Stale Session Detection
// ============================================================================

/**
 * Sweep for stale sessions and force-stop them
 *
 * A session is considered stale when:
 * - It hasn't been stopped (stoppedAt IS NULL)
 * - It hasn't been seen in a poll for > STALE_SESSION_TIMEOUT_SECONDS (default 5 min)
 *
 * This catches sessions where:
 * - Server became unreachable during playback
 * - SSE connection dropped and we missed the stop event
 * - The session hung on the media server side
 *
 * Stale sessions are marked with forceStopped = true to distinguish from normal stops.
 * Sessions with insufficient play time (< MIN_PLAY_TIME_MS) are still recorded for
 * audit purposes but can be filtered from stats queries.
 */
export async function sweepStaleSessions(): Promise<number> {
  try {
    // Calculate the stale threshold (sessions not seen in last 5 minutes)
    const staleThreshold = new Date(
      Date.now() - SESSION_LIMITS.STALE_SESSION_TIMEOUT_SECONDS * 1000
    );

    // Only check recent chunks to avoid locking all TimescaleDB partitions.
    // Active sessions can only exist in recent data - anything older would have
    // been force-stopped by previous sweeps. 7 days gives ample buffer.
    const chunkBound = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Find all active sessions that haven't been seen recently
    const staleSessions = await db
      .select()
      .from(sessions)
      .where(
        and(
          isNull(sessions.stoppedAt), // Still active
          lte(sessions.lastSeenAt, staleThreshold), // Not seen recently
          gte(sessions.startedAt, chunkBound) // Only recent chunks (reduces lock count)
        )
      );

    if (staleSessions.length === 0) {
      return 0;
    }

    console.log(`[Poller] Force-stopping ${staleSessions.length} stale session(s)`);

    const now = new Date();

    for (const staleSession of staleSessions) {
      // Check if session should be force-stopped (using the stateTracker function)
      if (!shouldForceStopStaleSession(staleSession.lastSeenAt)) {
        // Shouldn't happen since we already filtered, but double-check
        continue;
      }

      const { wasUpdated, needsRetry, retryData } = await stopSessionAtomic({
        session: staleSession,
        stoppedAt: now,
        forceStopped: true,
      });
      lastDbWriteMap.delete(staleSession.id);

      if (needsRetry && retryData && cacheService) {
        await cacheService.addSessionWriteRetry(staleSession.id, retryData);
      }

      if (!wasUpdated) {
        continue;
      }

      if (cacheService) {
        await cacheService.removeActiveSession(staleSession.id);
        await cacheService.removeUserSession(staleSession.serverUserId, staleSession.id);
      }

      if (pubSubService) {
        await pubSubService.publish('session:stopped', staleSession.id);
      }
    }

    // Invalidate dashboard stats after force-stopping sessions
    if (cacheService) {
      await cacheService.invalidateDashboardStatsCache();
    }

    return staleSessions.length;
  } catch (error) {
    console.error('[Poller] Error sweeping stale sessions:', error);
    return 0;
  }
}

// ============================================================================
// Lifecycle Management
// ============================================================================

/**
 * Initialize the poller with cache services
 */
export function initializePoller(cache: CacheService, pubSub: PubSubService): void {
  cacheService = cache;
  pubSubService = pubSub;
}

/**
 * Start the polling job
 */
export function startPoller(config: Partial<PollerConfig> = {}): void {
  const mergedConfig = { ...defaultConfig, ...config };

  if (!mergedConfig.enabled) {
    console.log('Session poller disabled');
    return;
  }

  if (pollingInterval) {
    console.log('Poller already running');
    return;
  }

  const initialInterval = POLLING_INTERVALS.SESSIONS_IDLE;
  currentPollIntervalMs = initialInterval;
  console.log(
    `Starting session poller (active: ${POLLING_INTERVALS.SESSIONS_ACTIVE}ms, idle: ${initialInterval}ms)`
  );

  // Run immediately on start
  void pollServers();

  // Then run on interval (starts idle, switches to active when sessions detected)
  pollingInterval = setInterval(() => void pollServers(), initialInterval);
  registerService('poller', {
    name: 'Session Poller',
    description: 'Polls media servers for active sessions',
    intervalMs: initialInterval,
  });

  // Start stale session sweep (runs every 60 seconds to detect abandoned sessions)
  if (!staleSweepInterval) {
    console.log(
      `Starting stale session sweep with ${SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS}ms interval`
    );
    staleSweepInterval = setInterval(
      () => void sweepStaleSessions(),
      SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS
    );
    registerService('stale-sweep', {
      name: 'Stale Session Sweep',
      description: 'Detects and stops abandoned sessions',
      intervalMs: SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS,
    });
  }
}

/**
 * Stop the polling job
 */
export function stopPoller(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    unregisterService('poller');
    console.log('Session poller stopped');
  }
  if (staleSweepInterval) {
    clearInterval(staleSweepInterval);
    staleSweepInterval = null;
    unregisterService('stale-sweep');
    console.log('Stale session sweep stopped');
  }
  missedPollTracking.clear();
  lastDbWriteMap.clear();
  previousPollHadSessions = false;
  currentPollIntervalMs = POLLING_INTERVALS.SESSIONS_IDLE;
}

/**
 * Force an immediate poll
 */
export async function triggerPoll(): Promise<void> {
  await pollServers();
}

/**
 * Reconciliation poll for SSE-connected servers
 *
 * This is a lighter poll that runs periodically to catch any events
 * that might have been missed by SSE. Only polls Plex servers that
 * have active SSE connections (not in fallback mode).
 *
 * Unlike the main poller, this processes results and updates the cache
 * to sync any sessions that SSE may have missed.
 */
export async function triggerReconciliationPoll(): Promise<void> {
  try {
    // Get all Plex servers with active SSE connections
    const allServers = await db.select().from(servers);
    const sseServers = allServers.filter(
      (server) => server.type === 'plex' && !sseManager.isInFallback(server.id)
    );

    if (sseServers.length === 0) {
      return;
    }

    console.log(
      `[Poller] Running reconciliation poll for ${sseServers.length} SSE-connected server(s)`
    );

    // Get cached session keys from atomic SET-based cache
    const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
    const cachedSessionKeys = new Set(cachedSessions.map((s) => `${s.serverId}:${s.sessionKey}`));

    // Get active V2 rules
    const activeRulesV2 = await getActiveRulesV2();

    // Collect results from all SSE servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedKeys: string[] = [];
    const allUpdatedSessions: ActiveSession[] = [];

    // Process each SSE server and collect results
    for (const server of sseServers) {
      const serverWithToken = server as ServerWithToken;
      const { newSessions, stoppedSessionKeys, updatedSessions } = await processServerSessions(
        serverWithToken,
        activeRulesV2,
        cachedSessionKeys,
        cachedSessions
      );
      allNewSessions.push(...newSessions);
      allStoppedKeys.push(...stoppedSessionKeys);
      allUpdatedSessions.push(...updatedSessions);
    }

    if (allNewSessions.length > 0 || allStoppedKeys.length > 0 || allUpdatedSessions.length > 0) {
      await processPollResults({
        newSessions: allNewSessions,
        stoppedKeys: allStoppedKeys,
        updatedSessions: allUpdatedSessions,
        cachedSessions,
        cacheService,
        pubSubService,
        enqueueNotification,
      });

      console.log(
        `[Poller] Reconciliation complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedKeys.length} stopped`
      );
    }
  } catch (error) {
    console.error('[Poller] Reconciliation poll error:', error);
  }
}
