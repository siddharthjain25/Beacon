import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import routes from './routes.js';
import authRoutes from './authRoutes.js';
import User from './models/User.js';
import { initDb, pool } from './db.js';

// Load environment variables
dotenv.config();

const fastify = Fastify({
  logger: true,
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
  secret: process.env.JWT_SECRET || 'supersecretkey',
  sign: {
    expiresIn: '100y', // Effectively never expires
  },
});

// Hook to support token in query params (useful for SSE)
fastify.addHook('onRequest', async (request, reply) => {
  if (!request.headers.authorization && request.query.token) {
    request.headers.authorization = `Bearer ${request.query.token}`;
  }
});

// Authentication decorator
fastify.decorate('authenticate', async (request, reply) => {
  // Try JWT first
  try {
    await request.jwtVerify();
    return;
  } catch (err) {
    // If JWT fails, check for API key
  }

  // Check for API key in Authorization header or query param
  const authHeader = request.headers.authorization;
  let apiKey = request.query.token || request.query.apiKey;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const potentialKey = authHeader.split(' ')[1];
    if (potentialKey.startsWith('bc_') || potentialKey.startsWith('bt_')) {
      apiKey = potentialKey;
    }
  }

  if (apiKey) {
    if (apiKey.startsWith('bc_')) {
      const user = await User.findOne({ apiKey });
      if (user) {
        request.user = { id: user._id.toString(), username: user.username };
        return;
      }
    } else if (apiKey.startsWith('bt_')) {
      const { username, topic: topicName } = request.params;
      if (username && topicName) {
        const user = await User.findOne({ username });
        if (user) {
          const { rows } = await pool.query(
            `SELECT tk.id, tk.permission, t.id AS topic_id
             FROM topic_api_keys tk
             JOIN topics t ON tk.topic_id = t.id
             WHERE tk.key_value = $1 AND t.name = $2 AND t.owner_id = $3`,
            [apiKey, topicName, user._id.toString()]
          );
          const keyInfo = rows[0];
          if (keyInfo) {
            const isWrite = request.method === 'POST';
            const isAllowed = 
              keyInfo.permission === 'all' || 
              (isWrite && keyInfo.permission === 'publish') || 
              (!isWrite && keyInfo.permission === 'subscribe');
              
            if (isAllowed) {
              request.user = { 
                id: user._id.toString(), 
                username: user.username,
                topicAuth: {
                  topicId: keyInfo.topic_id,
                  permission: keyInfo.permission
                }
              };
              return;
            }
          }
        }
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
    await fastify.listen({ port: parseInt(port, 10), host: '0.0.0.0' });
    console.log(`Server listening on http://0.0.0.0:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
