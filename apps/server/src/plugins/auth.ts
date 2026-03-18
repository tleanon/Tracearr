/**
 * Authentication plugin for Fastify
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { REDIS_KEYS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

// Public API token prefix
const PUBLIC_API_TOKEN_PREFIX = 'trr_pub_';

// Context attached to public API requests
export interface PublicApiContext {
  userId: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwner: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireMobile: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticatePublicApi: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    publicApiContext?: PublicApiContext;
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  await app.register(jwt, {
    secret,
    sign: {
      algorithm: 'HS256',
    },
    cookie: {
      cookieName: 'token',
      signed: false,
    },
  });

  // Authenticate decorator - verifies JWT
  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Require owner role decorator
  app.decorate('requireOwner', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();

      if (request.user.role !== 'owner') {
        reply.forbidden('Owner access required');
      }
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Require mobile token decorator - validates token was issued for mobile app
  // Also checks if the device has been blacklisted (session revoked)
  app.decorate('requireMobile', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();

      if (!request.user.mobile) {
        reply.forbidden('Mobile access token required');
        return;
      }

      // Check if this device's token has been blacklisted (session revoked)
      if (request.user.deviceId) {
        const blacklisted = await app.redis.get(
          REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(request.user.deviceId)
        );
        if (blacklisted) {
          reply.unauthorized('Session has been revoked');
          return;
        }
      }
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Public API authentication - validates bearer token from Authorization header
  app.decorate(
    'authenticatePublicApi',
    async function (request: FastifyRequest, reply: FastifyReply) {
      const authHeader = request.headers.authorization;

      if (!authHeader?.startsWith('Bearer ')) {
        return reply.unauthorized('Missing or invalid Authorization header');
      }

      const token = authHeader.slice(7); // Remove "Bearer "

      if (!token.startsWith(PUBLIC_API_TOKEN_PREFIX)) {
        return reply.unauthorized('Invalid API key format');
      }

      // Find user with matching token
      const [user] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.apiToken, token))
        .limit(1);

      if (!user) {
        return reply.unauthorized('Invalid API key');
      }

      if (user.role !== 'owner') {
        return reply.forbidden('API key is not associated with an owner account');
      }

      // Attach context for use in route handlers
      request.publicApiContext = { userId: user.id };
    }
  );
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['@fastify/cookie'],
});
