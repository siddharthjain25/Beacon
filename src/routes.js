import broker from './broker.js';
import User from './models/User.js';
import { pool } from './db.js';
import { queueWebhookDispatch } from './webhooks.js';
import Ajv from 'ajv';
import { nanoid } from 'nanoid';

const ajv = new Ajv();
const validatorsCache = new Map();

function getValidator(schema) {
  const schemaStr = JSON.stringify(schema);
  let validate = validatorsCache.get(schemaStr);
  if (!validate) {
    validate = ajv.compile(schema);
    // Maintain a maximum cache size of 1000 to prevent memory exhaustion
    if (validatorsCache.size > 1000) {
      const firstKey = validatorsCache.keys().next().value;
      validatorsCache.delete(firstKey);
    }
    validatorsCache.set(schemaStr, validate);
  }
  return validate;
}

const extractApiKey = (request) => {
  const potentialKey = request.headers?.authorization?.split(' ')[1];
  if (potentialKey?.startsWith('bc_') || potentialKey?.startsWith('bt_')) {
    return potentialKey;
  }
  return request.query?.token || request.query?.apiKey;
};

const verifyTopicKeyForPublish = async (apiKey, topicName, ownerId) => {
  const { rows } = await pool.query(
    `SELECT tk.id, tk.permission, t.id AS topic_id
     FROM topic_api_keys tk
     JOIN topics t ON tk.topic_id = t.id
     WHERE tk.key_value = $1 AND t.name = $2 AND t.owner_id = $3`,
    [apiKey, topicName, ownerId]
  );
  const keyInfo = rows[0];
  if (!keyInfo) return null;

  const isAllowed = keyInfo.permission === 'all' || keyInfo.permission === 'publish';
  if (!isAllowed) return null;

  return {
    topicId: keyInfo.topic_id,
    permission: keyInfo.permission
  };
};

/**
 * Fastify plugin defining the notification routes.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function beaconRoutes(fastify) {
  /**
   * Helper to find topic and check access
   */
  const checkPrivateAccess = async (topic, request, reply, ownerId, errorMessage = 'Access denied to private topic') => {
    if (!request.user) {
      if (!reply) {
        throw new Error('Authentication required but reply object is missing');
      }
      await fastify.authenticate(request, reply);
    }
    
    if (reply?.sent) return false;

    const isOwner = request.user.id === ownerId;
    const isAuthorized = topic.authorizedUsers?.includes(request.user.id) ?? false;
    const isTopicKeyAuth = request.user.topicAuth?.topicId === topic.id;

    if (!isOwner && !isAuthorized && !isTopicKeyAuth) {
      if (reply) reply.status(403).send({ error: errorMessage });
      return false;
    }
    return true;
  };

  /**
   * Helper to find topic and check access
   */
  const getTopicWithAccess = async (username, topicName, request, reply) => {
    const user = await User.findOne({ username });
    if (!user) {
      if (reply) reply.status(404).send({ error: 'User not found' });
      return null;
    }

    const { rows } = await pool.query(
      'SELECT id, name, owner_id AS "owner", is_private AS "isPrivate", description, webhooks, payload_schema AS "payloadSchema", authorized_users AS "authorizedUsers" FROM topics WHERE name = $1 AND owner_id = $2',
      [topicName, user._id.toString()]
    );
    const topic = rows[0];
    if (!topic) {
      if (reply) reply.status(404).send({ error: 'Topic not found' });
      return null;
    }
    
    // Map id to _id for frontend compatibility
    topic._id = topic.id;

    if (topic.isPrivate) {
      const hasAccess = await checkPrivateAccess(topic, request, reply, user._id.toString());
      if (!hasAccess) return null;
    }

    return topic;
  };

  /**
   * Create a new topic
   * POST /api/topics
   */
  fastify.post('/api/topics', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { name, isPrivate, description } = request.body;
    const owner = request.user.id;

    try {
      const { rows: existingRows } = await pool.query(
        'SELECT id FROM topics WHERE name = $1 AND owner_id = $2',
        [name, owner]
      );
      if (existingRows.length > 0) {
        return reply.status(400).send({ error: 'Topic already exists for this user' });
      }

      const { rows } = await pool.query(
        'INSERT INTO topics (name, owner_id, is_private, description) VALUES ($1, $2, $3, $4) RETURNING id, name, owner_id AS "owner", is_private AS "isPrivate", description, webhooks, payload_schema AS "payloadSchema", authorized_users AS "authorizedUsers", created_at AS "createdAt"',
        [name, owner, isPrivate || false, description || '']
      );

      const topic = rows[0];
      if (topic) topic._id = topic.id;

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
      const { rows } = await pool.query(
        'SELECT id, name, owner_id AS "owner", is_private AS "isPrivate", description, webhooks, payload_schema AS "payloadSchema", authorized_users AS "authorizedUsers", created_at AS "createdAt" FROM topics WHERE owner_id = $1 ORDER BY created_at DESC',
        [request.user.id]
      );

      const topics = rows.map(t => ({
        ...t,
        _id: t.id,
        owner: {
          _id: request.user.id,
          username: request.user.username
        }
      }));

      return topics;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch your topics' });
    }
  });

  /**
   * Update topic settings
   * PATCH /api/topics/:id
   */
  fastify.patch('/api/topics/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const updates = request.body;
    
    // Only allow specific fields to be updated
    const allowedUpdates = new Set(['isPrivate', 'description', 'webhooks', 'payloadSchema']);
    const actualUpdates = {};
    
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.has(key)) {
        actualUpdates[key] = updates[key];
      }
    });

    if (Object.keys(actualUpdates).length === 0) {
      return reply.status(400).send({ error: 'No valid updates provided' });
    }

    try {
      const setClauses = [];
      const values = [];
      let paramIndex = 1;

      // Map js camelCase fields to postgres snake_case fields
      const fieldMapping = {
        isPrivate: 'is_private',
        description: 'description',
        webhooks: 'webhooks',
        payloadSchema: 'payload_schema'
      };

      for (const [key, value] of Object.entries(actualUpdates)) {
        const dbField = fieldMapping[key];
        setClauses.push(`${dbField} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }

      // Add id and owner_id parameters
      values.push(id, request.user.id);
      const query = `
        UPDATE topics 
        SET ${setClauses.join(', ')} 
        WHERE id = $${paramIndex} AND owner_id = $${paramIndex + 1}
        RETURNING id, name, owner_id AS "owner", is_private AS "isPrivate", description, webhooks, payload_schema AS "payloadSchema", authorized_users AS "authorizedUsers", created_at AS "createdAt"
      `;

      const { rows } = await pool.query(query, values);
      const topic = rows[0];
      
      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }

      topic._id = topic.id;
      topic.owner = {
        _id: request.user.id,
        username: request.user.username
      };
      
      return topic;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to update topic' });
    }
  });

  /**
   * Delete a topic and its messages
   * DELETE /api/topics/:id
   */
  fastify.delete('/api/topics/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM topics WHERE id = $1 AND owner_id = $2',
        [id, request.user.id]
      );
      
      if (rowCount === 0) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }
      
      return { status: 'ok', message: 'Topic and its messages deleted' };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to delete topic' });
    }
  });

  /**
   * Create a new topic API key
   * POST /api/topics/:id/keys
   */
  fastify.post('/api/topics/:id/keys', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const { name, permission } = request.body;
    
    if (!name || !permission) {
      return reply.status(400).send({ error: 'Name and permission are required' });
    }

    try {
      // Verify topic ownership
      const { rows: topicRows } = await pool.query(
        'SELECT id FROM topics WHERE id = $1 AND owner_id = $2',
        [id, request.user.id]
      );
      if (topicRows.length === 0) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }

      const keyValue = `bt_${nanoid(32)}`;

      const { rows } = await pool.query(
        'INSERT INTO topic_api_keys (topic_id, name, key_value, permission) VALUES ($1, $2, $3, $4) RETURNING id, name, key_value AS "keyValue", permission, created_at AS "createdAt"',
        [id, name, keyValue, permission]
      );

      return rows[0];
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to create topic key' });
    }
  });

  /**
   * Get all API keys for a topic
   * GET /api/topics/:id/keys
   */
  fastify.get('/api/topics/:id/keys', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;

    try {
      // Verify topic ownership
      const { rows: topicRows } = await pool.query(
        'SELECT id FROM topics WHERE id = $1 AND owner_id = $2',
        [id, request.user.id]
      );
      if (topicRows.length === 0) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }

      const { rows } = await pool.query(
        'SELECT id, name, key_value AS "keyValue", permission, created_at AS "createdAt" FROM topic_api_keys WHERE topic_id = $1 ORDER BY created_at DESC',
        [id]
      );

      // Mask key value except for first and last few characters for security
      const maskedKeys = rows.map(k => ({
        ...k,
        keyValue: `${k.keyValue.slice(0, 7)}...${k.keyValue.slice(-4)}`
      }));

      return maskedKeys;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch topic keys' });
    }
  });

  /**
   * Delete a topic API key
   * DELETE /api/topics/:id/keys/:keyId
   */
  fastify.delete('/api/topics/:id/keys/:keyId', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id, keyId } = request.params;

    try {
      // Verify topic ownership
      const { rows: topicRows } = await pool.query(
        'SELECT id FROM topics WHERE id = $1 AND owner_id = $2',
        [id, request.user.id]
      );
      if (topicRows.length === 0) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }

      const { rowCount } = await pool.query(
        'DELETE FROM topic_api_keys WHERE id = $1 AND topic_id = $2',
        [keyId, id]
      );

      if (rowCount === 0) {
        return reply.status(404).send({ error: 'Key not found' });
      }

      return { status: 'ok', message: 'Topic API key deleted' };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to delete topic key' });
    }
  });

  /**
   * Subscriber endpoint (WebSocket)
   * GET /ws/:username/:topic
   */
  fastify.get('/ws/:username/:topic', { 
    websocket: true,
    preHandler: async (request, reply) => {
      const { username, topic: topicName } = request.params;
      const topic = await getTopicWithAccess(username, topicName, request, reply);
      if (!topic) return;
      request.topic = topic;
    }
  }, async (connection, request) => {
    const { username, topic: topicName } = request.params;
    
    const topic = request.topic;
    if (!topic) {
      connection.socket.close();
      return;
    }

    const brokerTopic = `${username}/${topicName}`;
    const listener = (data) => {
      connection.socket.send(typeof data === 'string' ? data : JSON.stringify(data));
    };

    broker.on(brokerTopic, listener);
    fastify.log.info(`WS Subscriber connected to topic: ${brokerTopic}`);

    connection.socket.on('close', () => {
      broker.removeListener(brokerTopic, listener);
      fastify.log.info(`WS Subscriber disconnected from topic: ${brokerTopic}`);
    });
  });

  /**
   * Topics discovery endpoint
   * GET /api/topics
   */
  fastify.get('/api/topics', async (request, reply) => {
    try {
      // Only return public topics
      const { rows } = await pool.query(
        'SELECT id, name, owner_id AS "owner", is_private AS "isPrivate", description, webhooks, payload_schema AS "payloadSchema", authorized_users AS "authorizedUsers", created_at AS "createdAt" FROM topics WHERE is_private = false'
      );

      // Get unique owner IDs
      const ownerIds = [...new Set(rows.map(t => t.owner))];

      // Fetch users from MongoDB
      const users = await User.find({ _id: { $in: ownerIds } }).select('username').lean();
      const userMap = users.reduce((acc, u) => {
        acc[u._id.toString()] = { _id: u._id.toString(), username: u.username };
        return acc;
      }, {});

      const topics = rows.map(t => ({
        ...t,
        _id: t.id,
        owner: userMap[t.owner] || { _id: t.owner, username: 'unknown' }
      }));

      return { topics };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch topics' });
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

    return reply;
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
      const { rows } = await pool.query(
        'SELECT id, topic_id AS "topic", payload, created_at AS "createdAt" FROM messages WHERE topic_id = $1 ORDER BY created_at DESC LIMIT 50',
        [topic.id]
      );
      
      return rows.reverse();
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch history' });
    }
  });

  const authenticatePublishRequest = async (request, topicName, ownerId, username) => {
    if (!(request.headers?.authorization || request.query?.token || request.query?.apiKey)) {
      return;
    }

    try {
      await request.jwtVerify();
      return;
    } catch (err) {
      request.log.debug(`JWT verification failed (falling back to API key): ${err.message}`);
    }

    const apiKey = extractApiKey(request);
    if (!apiKey) return;

    if (apiKey.startsWith('bc_')) {
      const dbUser = await User.findOne({ apiKey });
      if (dbUser) {
        request.user = { id: dbUser._id.toString(), username: dbUser.username };
      }
    } else if (apiKey.startsWith('bt_')) {
      const topicAuth = await verifyTopicKeyForPublish(apiKey, topicName, ownerId);
      if (topicAuth) {
        request.user = { id: ownerId, username, topicAuth };
      }
    }
  };

  const getOrCreateTopicForPublish = async (request, reply, user, topicName) => {
    const { rows } = await pool.query(
      'SELECT id, name, owner_id AS "owner", is_private AS "isPrivate", description, webhooks, payload_schema AS "payloadSchema", authorized_users AS "authorizedUsers" FROM topics WHERE name = $1 AND owner_id = $2',
      [topicName, user._id.toString()]
    );
    let topic = rows[0];

    if (!topic) {
      const isOwner = request.user?.id === user._id.toString() && !request.user?.topicAuth;
      if (isOwner) {
        const { rows: newTopicRows } = await pool.query(
          'INSERT INTO topics (name, owner_id, is_private, description) VALUES ($1, $2, $3, $4) RETURNING id, name, owner_id AS "owner", is_private AS "isPrivate", description, webhooks, payload_schema AS "payloadSchema", authorized_users AS "authorizedUsers"',
          [topicName, user._id.toString(), true, 'Automatically provisioned endpoint']
        );
        topic = newTopicRows[0];
        fastify.log.info(`Topic /${user.username}/${topicName} automatically provisioned.`);
      }
    }
    return topic;
  };

  /**
   * Publisher endpoint
   * POST /:username/:topic
   */
  fastify.post('/:username/:topic', async (request, reply) => {
    const { username, topic: topicName } = request.params;
    const payload = request.body;

    try {
      const user = await User.findOne({ username });
      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      await authenticatePublishRequest(request, topicName, user._id.toString(), user.username);

      const topic = await getOrCreateTopicForPublish(request, reply, user, topicName);
      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found' });
      }

      if (topic.isPrivate) {
        const hasAccess = await checkPrivateAccess(
          topic,
          request,
          reply,
          user._id.toString(),
          'Only the topic owner or authorized users can publish'
        );
        if (!hasAccess || reply.sent) return;
      }

      // Payload Validation
      if (topic.payloadSchema) {
        const validate = getValidator(topic.payloadSchema);
        const valid = validate(payload);
        if (!valid) {
          return reply.status(400).send({ 
            error: 'Payload does not match topic schema', 
            details: validate.errors 
          });
        }
      }

      // Save message to database
      const { rows } = await pool.query(
        'INSERT INTO messages (topic_id, payload) VALUES ($1, $2) RETURNING id',
        [topic.id, JSON.stringify(payload)]
      );
      const messageId = rows[0].id;

      // Emit the message to the broker for real-time subscribers
      const brokerTopic = `${username}/${topicName}`;
      broker.emit(brokerTopic, payload);

      // Dispatch Webhooks
      queueWebhookDispatch(topic, messageId, payload);

      return { status: 'ok', topic: topicName, message: 'Notification sent and saved' };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to process notification' });
    }
  });

  /**
   * Analytics endpoint
   * GET /api/analytics/:topicId
   */
  fastify.get('/api/analytics/:topicId', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { topicId } = request.params;
    
    try {
      const { rows: topicRows } = await pool.query(
        'SELECT id FROM topics WHERE id = $1 AND owner_id = $2',
        [topicId, request.user.id]
      );
      const topic = topicRows[0];
      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }

      const { rows: totalRows } = await pool.query(
        'SELECT COUNT(*)::int AS count FROM messages WHERE topic_id = $1',
        [topic.id]
      );
      const totalMessages = totalRows[0].count;
      
      // Last 24 hours
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const { rows: last24hRows } = await pool.query(
        'SELECT COUNT(*)::int AS count FROM messages WHERE topic_id = $1 AND created_at >= $2',
        [topic.id, last24h]
      );
      const messagesLast24h = last24hRows[0].count;

      // Group by day for the last 7 days
      const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const { rows: dailyRows } = await pool.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS _id, COUNT(*)::int AS count 
         FROM messages 
         WHERE topic_id = $1 AND created_at >= $2 
         GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD') 
         ORDER BY _id ASC`,
        [topic.id, last7d]
      );

      return {
        totalMessages,
        messagesLast24h,
        dailyStats: dailyRows
      };
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch analytics' });
    }
  });

  /**
   * Get webhook logs for a topic
   * GET /api/topics/:id/webhook-logs
   */
  fastify.get('/api/topics/:id/webhook-logs', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    try {
      // Check if topic exists and is owned by request.user.id
      const { rows: topicRows } = await pool.query(
        'SELECT id FROM topics WHERE id = $1 AND owner_id = $2',
        [id, request.user.id]
      );
      const topic = topicRows[0];
      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found or access denied' });
      }

      // Fetch last 50 webhook logs
      const { rows: logs } = await pool.query(
        `SELECT id, message_id AS "messageId", url, status_code AS "statusCode", request_payload AS "requestPayload", response_payload AS "responsePayload", duration_ms AS "durationMs", success, error_message AS "errorMessage", attempts, created_at AS "createdAt"
         FROM webhook_logs 
         WHERE topic_id = $1 
         ORDER BY created_at DESC 
         LIMIT 50`,
        [topic.id]
      );

      return logs;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch webhook logs' });
    }
  });
}
