import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import routes from './routes.js';
import authRoutes from './authRoutes.js';
import User from './models/User.js';

// Load environment variables
dotenv.config();

const fastify = Fastify({
  logger: true,
});

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
    if (potentialKey.startsWith('bc_')) {
      apiKey = potentialKey;
    }
  }

  if (apiKey) {
    const user = await User.findOne({ apiKey });
    if (user) {
      request.user = { id: user._id.toString(), username: user.username };
      return;
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

    const port = process.env.PORT || 3000;
    await fastify.listen({ port: parseInt(port, 10), host: '0.0.0.0' });
    console.log(`Server listening on http://0.0.0.0:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
