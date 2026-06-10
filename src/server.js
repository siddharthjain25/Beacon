import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import routes from './routes.js';
import authRoutes from './authRoutes.js';
import User from './models/User.js';
import { initDb, pool } from './db.js';
import { createVelicorLogger } from './velicorLogger.js';

// Load environment variables
dotenv.config();

// Handle uncaught exceptions and unhandled rejections to log them properly in the console
process.on('uncaughtException', (err) => {
  console.error('💥 CRITICAL UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
});

const fastify = Fastify({
  logger: createVelicorLogger({
    level: 'info'
  })
});

// Global Error Handler
fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;

  if (statusCode >= 500) {
    request.log.error(error);
  } else {
    // Log client-side errors (4xx) cleanly as warnings without stack traces
    request.log.warn({
      code: error.code,
      message: error.message,
      statusCode
    }, `Client request error: ${error.message}`);
  }

  reply.status(statusCode).send({
    error: error.name || 'Error',
    code: error.code,
    message: error.message,
    statusCode
  });
});

// Remove default text/plain parser so it falls back to the wildcard * parser
fastify.removeContentTypeParser('text/plain');

// Register a wildcard content-type parser to handle all unsupported and missing media types
fastify.addContentTypeParser('*', { parseAs: 'string' }, (request, payload, done) => {
  if (!payload) {
    return done(null, payload);
  }
  try {
    const json = JSON.parse(payload);
    return done(null, json);
  } catch (err) {
    // Check if it looks like URL-encoded form data (e.g., key1=value1&key2=value2)
    if (payload.includes('=') && !payload.includes('{') && !payload.includes('[')) {
      try {
        const params = new URLSearchParams(payload);
        const obj = {};
        for (const [key, value] of params.entries()) {
          obj[key] = value;
        }
        return done(null, obj);
      } catch (e) {
        // ignore and fallback
      }
    }
    return done(null, payload);
  }
});

// Register Rate Limit
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    return request.user?.id || request.ip;
  },
});

// Register WebSocket
fastify.register(websocket);

// Register JWT
fastify.register(jwt, {
  secret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  sign: {
    expiresIn: '100y', // Effectively never expires
  },
});

// Hook to support token in query params (useful for SSE)
fastify.addHook('onRequest', async (request, reply) => {
  if (!request.headers?.authorization && request.query?.token) {
    request.headers.authorization = `Bearer ${request.query.token}`;
  }
});

const extractApiKey = (request) => {
  const potentialKey = request.headers?.authorization?.split(' ')[1];
  if (potentialKey?.startsWith('bc_') || potentialKey?.startsWith('bt_')) {
    return potentialKey;
  }
  return request.query?.token || request.query?.apiKey;
};

const verifyTopicApiKey = async (apiKey, request) => {
  const { username, topic: topicName } = request.params;
  if (!username || !topicName) return null;

  const user = await User.findOne({ username });
  if (!user) return null;

  const { rows } = await pool.query(
    `SELECT tk.id, tk.permission, t.id AS topic_id
     FROM topic_api_keys tk
     JOIN topics t ON tk.topic_id = t.id
     WHERE tk.key_value = $1 AND t.name = $2 AND t.owner_id = $3`,
    [apiKey, topicName, user._id.toString()]
  );
  const keyInfo = rows[0];
  if (!keyInfo) return null;

  const isWrite = request.method === 'POST';
  const isAllowed = 
    keyInfo.permission === 'all' || 
    (isWrite && keyInfo.permission === 'publish') || 
    (!isWrite && keyInfo.permission === 'subscribe');

  if (!isAllowed) return null;

  return { 
    id: user._id.toString(), 
    username: user.username,
    topicAuth: {
      topicId: keyInfo.topic_id,
      permission: keyInfo.permission
    }
  };
};

// Authentication decorator
fastify.decorate('authenticate', async (request, reply) => {
  // Try JWT first
  try {
    await request.jwtVerify();
    return;
  } catch (err) {
    request.log.debug(`JWT verification failed, trying API key fallback: ${err.message}`);
  }

  const apiKey = extractApiKey(request);
  if (apiKey) {
    if (apiKey.startsWith('bc_')) {
      const user = await User.findOne({ apiKey });
      if (user) {
        request.user = { id: user._id.toString(), username: user.username };
        return;
      }
    } else if (apiKey.startsWith('bt_')) {
      const topicUser = await verifyTopicApiKey(apiKey, request);
      if (topicUser) {
        request.user = topicUser;
        return;
      }
    }
  }

  reply.status(401).send({ error: 'Authentication required' });
});

// Register CORS
fastify.register(cors, {
  origin: '*', // In production, you should restrict this
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Redirect root / to frontend UI
fastify.get('/', async (request, reply) => {
  return reply.redirect('https://beaconop-ui.vercel.app');
});

// Register routes
fastify.register(authRoutes, { prefix: '/api/auth' });
fastify.register(routes);

/**
 * Run the server!
 */
const start = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/beacon';
    await mongoose.connect(mongoUri);
    fastify.log.info('Connected to MongoDB');

    // Connect and initialize Postgres
    await initDb();
    fastify.log.info('Connected and initialized PostgreSQL');

    const port = process.env.PORT || 3000;
    await fastify.listen({ port: Number.parseInt(port, 10), host: '0.0.0.0' });
    console.log(`Server listening on http://0.0.0.0:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

try {
  await start();
} catch (err) {
  console.error('💥 FAILED TO START SERVER:', err);
  process.exit(1);
}
