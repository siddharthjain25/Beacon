import User from './models/User.js';
import { nanoid } from 'nanoid';

/**
 * Fastify plugin defining the authentication routes.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function authRoutes(fastify) {
  /**
   * Register a new user
   * POST /api/auth/register
   */
  fastify.post('/register', async (request, reply) => {
    const { username, password, firstName, lastName } = request.body;

    try {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return reply.status(400).send({ error: 'Username already taken' });
      }

      const user = new User({ username, password, firstName, lastName });
      const rawApiKey = user.apiKey; // Capture raw generated key before save hashes/clears it
      await user.save();

      const token = fastify.jwt.sign({ id: user._id, username: user.username });
      return { 
        token, 
        user: { 
          id: user._id, 
          username: user.username, 
          firstName: user.firstName, 
          lastName: user.lastName, 
          apiKey: rawApiKey 
        } 
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to register user' });
    }
  });

  /**
   * Login user
   * POST /api/auth/login
   */
  fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body;

    try {
      const user = await User.findOne({ username });
      if (!user || !(await user.comparePassword(password))) {
        return reply.status(401).send({ error: 'Invalid username or password' });
      }

      const token = fastify.jwt.sign({ id: user._id, username: user.username });
      return { 
        token, 
        user: { 
          id: user._id, 
          username: user.username, 
          firstName: user.firstName, 
          lastName: user.lastName, 
          apiKey: user.apiKeyDisplay || user.apiKey // Fallback to legacy plaintext key if display value is not set
        } 
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to login' });
    }
  });

  /**
   * Get current user
   * GET /api/auth/me
   */
  fastify.get('/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = await User.findById(request.user.id).select('username firstName lastName apiKey apiKeyDisplay').lean();
    if (!user) return reply.status(404).send({ error: 'User not found' });
    
    // Map display value to apiKey property so frontend doesn't break
    user.apiKey = user.apiKeyDisplay || user.apiKey;
    delete user.apiKeyDisplay;
    
    return user;
  });

  /**
   * Update user profile
   * PUT /api/auth/profile
   */
  fastify.put('/profile', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { firstName, lastName } = request.body;
    try {
      const user = await User.findByIdAndUpdate(
        request.user.id,
        { firstName, lastName },
        { new: true, runValidators: true }
      ).select('username firstName lastName apiKey apiKeyDisplay').lean();
      
      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      user.apiKey = user.apiKeyDisplay || user.apiKey;
      delete user.apiKeyDisplay;
      
      return user;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to update profile' });
    }
  });

  /**
   * Reset API Key
   * POST /api/auth/reset-api-key
   */
  fastify.post('/reset-api-key', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const newApiKey = `bc_${nanoid(32)}`;
      const user = await User.findById(request.user.id);

      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      user.apiKey = newApiKey;
      await user.save();

      return {
        id: user._id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        apiKey: newApiKey // Return the raw key once so the user can copy it
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to reset API key' });
    }
  });
}
