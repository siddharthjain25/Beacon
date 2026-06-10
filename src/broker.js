import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Broker implementation that supports both local EventEmitter and Redis Pub/Sub.
 */
class Broker extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.useRedis = process.env.REDIS_URL ? true : false;
    
    if (this.useRedis) {
      console.log('Broker: Using Redis Pub/Sub');
      this.pub = new Redis(process.env.REDIS_URL);
      this.sub = new Redis(process.env.REDIS_URL);
      
      this.sub.on('message', (channel, message) => {
        // Emit locally when a message is received from Redis
        try {
          const data = JSON.parse(message);
          super.emit(channel, data);
        } catch (err) {
          // Fallback to raw message string if it is not valid JSON
          console.debug(`Broker: Message is not valid JSON, emitting as raw string: ${err.message}`);
          super.emit(channel, message);
        }
      });
    } else {
      console.log('Broker: Using local EventEmitter (Redis not configured)');
    }
  }

  /**
   * Publish a message to a topic.
   * @param {string} topic 
   * @param {any} data 
   */
  emit(topic, data) {
    if (this.useRedis) {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      this.pub.publish(topic, message);
    }
    // Always emit locally for instances on the same process
    return super.emit(topic, data);
  }

  /**
   * Subscribe to a topic.
   * @param {string} topic 
   * @param {Function} listener 
   */
  on(topic, listener) {
    if (this.useRedis) {
      this.sub.subscribe(topic).catch(err => {
        console.error(`Broker: Failed to subscribe to ${topic}:`, err);
      });
    }
    return super.on(topic, listener);
  }

  /**
   * Unsubscribe from a topic.
   * @param {string} topic 
   * @param {Function} listener 
   */
  removeListener(topic, listener) {
    const result = super.removeListener(topic, listener);
    
    // If no more local listeners, unsubscribe from Redis
    if (this.useRedis && this.listenerCount(topic) === 0) {
      this.sub.unsubscribe(topic).catch(err => {
        console.error(`Broker: Failed to unsubscribe from ${topic}:`, err);
      });
    }
    
    return result;
  }
}

const broker = new Broker();
export default broker;
