/**
 * Setup routes - Check if Tracearr has been configured
 */

import type { FastifyPluginAsync } from 'fastify';
import { isNotNull, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, users, settings } from '../db/schema.js';
import { isClaimCodeEnabled } from '../utils/claimCode.js';

export const setupRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /setup/status - Check Tracearr configuration status
   *
   * This endpoint is public (no auth required) so the frontend
   * can determine whether to show the setup wizard or login page.
   *
   * Returns:
   * - needsSetup: true if no owner accounts exist
   * - requiresClaimCode: true if first-time setup requires a claim code
   * - hasServers: true if at least one server is configured
   * - hasPasswordAuth: true if at least one user has password login enabled
   */
  app.get('/status', async () => {
    // Check for servers and users in parallel
    const [serverList, jellyfinServerList, ownerList, passwordUserList] = await Promise.all([
      db.select({ id: servers.id }).from(servers).limit(1),
      db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'jellyfin')).limit(1),
      db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1),
      db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1),
    ]);

    // Try to get primaryAuthMethod from settings, but handle case where column doesn't exist yet
    let primaryAuthMethod: 'jellyfin' | 'local' = 'local';
    try {
      const settingsRow = await db
        .select({ primaryAuthMethod: settings.primaryAuthMethod })
        .from(settings)
        .limit(1);
      if (settingsRow[0]?.primaryAuthMethod) {
        primaryAuthMethod = settingsRow[0].primaryAuthMethod;
      }
    } catch {
      // Column doesn't exist yet (migration not run) - use default
      primaryAuthMethod = 'local';
    }

    const needsSetup = ownerList.length === 0;

    return {
      needsSetup,
      requiresClaimCode: needsSetup && isClaimCodeEnabled(), // Claim code required only if enabled and setup needed
      hasServers: serverList.length > 0,
      hasJellyfinServers: jellyfinServerList.length > 0,
      hasPasswordAuth: passwordUserList.length > 0,
      primaryAuthMethod,
    };
  });
};
