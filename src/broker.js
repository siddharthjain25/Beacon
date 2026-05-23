import { EventEmitter } from 'events';

/**
 * Singleton instance of EventEmitter to act as the in-memory message broker.
 */
const broker = new EventEmitter();

// Increase max listeners if many subscribers are expected for a single topic
broker.setMaxListeners(0);

export default broker;
