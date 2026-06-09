import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.POSTGRES_URI,
});

async function run() {
  try {
    const { rows: topics } = await pool.query('SELECT * FROM topics');
    console.log("Topics in Postgres:", topics);
    const { rows: messages } = await pool.query('SELECT * FROM messages');
    console.log("Messages in Postgres:", messages);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await pool.end();
  }
}

run();
