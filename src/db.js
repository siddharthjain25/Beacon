import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.POSTGRES_URI || 'postgresql://localhost:5432/beacon';

export const pool = new Pool({
  connectionString,
});

/**
 * Initialize Postgres tables if they don't exist
 */
export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Create topics table
    await client.query(`
      CREATE TABLE IF NOT EXISTS topics (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        owner_id VARCHAR(24) NOT NULL,
        is_private BOOLEAN DEFAULT FALSE,
        description TEXT DEFAULT '',
        webhooks TEXT[] DEFAULT '{}',
        payload_schema JSONB DEFAULT NULL,
        authorized_users VARCHAR(24)[] DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (name, owner_id)
      )
    `);

    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        topic_id INT REFERENCES topics(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create topic_api_keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS topic_api_keys (
        id SERIAL PRIMARY KEY,
        topic_id INT REFERENCES topics(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        key_value VARCHAR(100) UNIQUE NOT NULL,
        permission VARCHAR(20) DEFAULT 'publish',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_topic_created 
      ON messages(topic_id, created_at DESC)
    `);

    // Create webhook_logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        topic_id INT REFERENCES topics(id) ON DELETE CASCADE,
        message_id INT REFERENCES messages(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        status_code INT,
        request_payload JSONB NOT NULL,
        response_payload TEXT,
        duration_ms INT,
        success BOOLEAN DEFAULT FALSE,
        error_message TEXT,
        attempts INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index on webhook_logs
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_topic
      ON webhook_logs(topic_id, created_at DESC)
    `);

    await client.query('COMMIT');
    console.log('Postgres tables initialized successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to initialize Postgres tables:', err);
    throw err;
  } finally {
    client.release();
  }
}
