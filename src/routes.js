import broker from './broker.js';
import Message from './models/Message.js';
import User from './models/User.js';
import Topic from './models/Topic.js';

/**
 * Fastify plugin defining the notification routes.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function (fastify) {
  /**
   * Helper to find topic and check access
   */
  const getTopicWithAccess = async (username, topicName, request, reply) => {
    const user = await User.findOne({ username });
    if (!user) {
      reply.status(404).send({ error: 'User not found' });
      return null;
    }

    const topic = await Topic.findOne({ name: topicName, owner: user._id });
    if (!topic) {
      reply.status(404).send({ error: 'Topic not found' });
      return null;
    }

    if (topic.isPrivate) {
      // Authenticate using the common decorator (handles JWT and API Keys)
      if (!request.user) {
        await fastify.authenticate(request, reply);
      }
      
      if (reply.sent) return null;

      if (request.user.id !== user._id.toString()) {
        reply.status(403).send({ error: 'Access denied to private topic' });
        return null;
      }
    }

    return topic;
  };

  /**
   * Create a new topic
   * POST /api/topics
   */
  fastify.post('/api/topics', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { name, isPrivate } = request.body;
    const owner = request.user.id;

    try {
      const existingTopic = await Topic.findOne({ name, owner });
      if (existingTopic) {
        return reply.status(400).send({ error: 'Topic already exists for this user' });
      }

      const topic = new Topic({ name, owner, isPrivate });
      await topic.save();

      return topic;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to create topic' });
    }
  });

  /**
   * Get all topics for the logged-in user
   * GET /api/my-topics
   */
  fastify.get('/api/my-topics', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const topics = await Topic.find({ owner: request.user.id }).sort({ createdAt: -1 });
      return topics;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch your topics' });
    }
  });

  /**
   * Toggle topic privacy
   * PATCH /api/topics/:id/toggle-privacy
   */
  fastify.patch('/api/topics/:id/toggle-privacy', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    try {
      const topic = await Topic.findOne({ _id: id, owner: request.user.id });
      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }
      
      topic.isPrivate = !topic.isPrivate;
      await topic.save();
      
      return topic;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to toggle privacy' });
    }
  });

  /**
   * Delete a topic and its messages
   * DELETE /api/topics/:id
   */
  fastify.delete('/api/topics/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    try {
      const topic = await Topic.findOne({ _id: id, owner: request.user.id });
      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }
      
      // Delete all messages associated with this topic
      await Message.deleteMany({ topic: id });
      
      // Delete the topic itself
      await Topic.deleteOne({ _id: id });
      
      return { status: 'ok', message: 'Topic and its messages deleted' };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to delete topic' });
    }
  });

  /**
   * Subscriber endpoint (SSE)
   * GET /:username/:topic
   */
  fastify.get('/:username/:topic', async (request, reply) => {
    const { username, topic: topicName } = request.params;

    const topic = await getTopicWithAccess(username, topicName, request, reply);
    if (!topic) return;

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });

    // Send an initial message to establish the connection
    reply.raw.write('retry: 10000\n\n');
    reply.raw.write('data: {"status":"connected"}\n\n');

    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15000);

    const brokerTopic = `${username}/${topicName}`;
    const listener = (data) => {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      reply.raw.write(`data: ${message}\n\n`);
    };

    // Attach listener to broker
    broker.on(brokerTopic, listener);
    fastify.log.info(`SSE Subscriber connected to topic: ${brokerTopic}`);

    // Clean up when client disconnects
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      broker.removeListener(brokerTopic, listener);
      fastify.log.info(`SSE Subscriber disconnected from topic: ${brokerTopic}`);
    });
  });

  /**
   * History endpoint
   * GET /api/history/:username/:topic
   */
  fastify.get('/api/history/:username/:topic', async (request, reply) => {
    const { username, topic: topicName } = request.params;
    
    const topic = await getTopicWithAccess(username, topicName, request, reply);
    if (!topic) return;

    try {
      const messages = await Message.find({ topic: topic._id })
        .sort({ createdAt: -1 })
        .limit(50);
      
      return messages.reverse();
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch history' });
    }
  });

  /**
   * Topics discovery endpoint
   * GET /api/topics
   */
  fastify.get('/api/topics', async (request, reply) => {
    try {
      // Only return public topics
      const topics = await Topic.find({ isPrivate: false }).populate('owner', 'username');
      return { topics };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch topics' });
    }
  });

  /**
   * Publisher endpoint
   * POST /:username/:topic
   */
  fastify.post('/:username/:topic', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { username, topic: topicName } = request.params;
    const payload = request.body;

    const user = await User.findOne({ username });
    if (!user || request.user.id !== user._id.toString()) {
      return reply.status(403).send({ error: 'Only the topic owner can publish' });
    }

    const topic = await Topic.findOne({ name: topicName, owner: user._id });
    if (!topic) {
      return reply.status(404).send({ error: 'Topic not found' });
    }

    try {
      // Save message to database
      const newMessage = new Message({
        topic: topic._id,
        payload,
      });
      await newMessage.save();

      // Emit the message to the broker for real-time subscribers
      const brokerTopic = `${username}/${topicName}`;
      broker.emit(brokerTopic, payload);

      return { status: 'ok', topic: topicName, message: 'Notification sent and saved' };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to process notification' });
    }
  });
}
