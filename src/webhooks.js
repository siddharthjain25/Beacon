import axios from 'axios';
import { pool } from './db.js';

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000; // 2 seconds base delay

/**
 * Dispatch a webhook to a URL and log the attempt.
 * Retries up to MAX_ATTEMPTS times with exponential backoff on failure.
 *
 * @param {number} topicId 
 * @param {number} messageId 
 * @param {string} url 
 * @param {object} payload 
 * @param {number} [attempt=1] 
 * @param {number} [existingLogId=null] 
 */
function prepareWebhookPayload(url, payload) {
  const isSlackCompatible = url.includes('/hooks.slack.com') || url.endsWith('/slack');
  if (isSlackCompatible && typeof payload === 'object' && !payload?.text && payload?.message) {
    return {
      ...payload,
      text: payload.message
    };
  }
  return payload;
}

async function logWebhookAttempt(existingLogId, details) {
  const { topicId, messageId, url, statusCode, requestPayload, responsePayload, durationMs, success, errorMessage, attempt } = details;
  try {
    if (existingLogId) {
      await pool.query(
        `UPDATE webhook_logs 
         SET status_code = $1, response_payload = $2, duration_ms = $3, success = $4, error_message = $5, attempts = $6, created_at = CURRENT_TIMESTAMP
         WHERE id = $7`,
        [statusCode, responsePayload || null, durationMs, success, errorMessage || null, attempt, existingLogId]
      );
      return existingLogId;
    } else {
      const { rows } = await pool.query(
        `INSERT INTO webhook_logs 
         (topic_id, message_id, url, status_code, request_payload, response_payload, duration_ms, success, error_message, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [topicId, messageId, url, statusCode, requestPayload, responsePayload || null, durationMs, success, errorMessage || null, attempt]
      );
      return rows[0].id;
    }
  } catch (dbErr) {
    console.error('Failed to log webhook attempt to DB:', dbErr);
    return existingLogId;
  }
}

/**
 * Dispatch a webhook to a URL and log the attempt.
 * Retries up to MAX_ATTEMPTS times with exponential backoff on failure.
 *
 * @param {number} topicId 
 * @param {number} messageId 
 * @param {string} url 
 * @param {object} payload 
 * @param {number} [attempt=1] 
 * @param {number} [existingLogId=null] 
 */
async function dispatchSingleWebhook(topicId, messageId, url, payload, attempt = 1, existingLogId = null) {
  const startTime = Date.now();
  let statusCode = null;
  let responsePayload = '';
  let success = false;
  let errorMessage = '';

  const finalPayload = prepareWebhookPayload(url, payload);

  try {
    const response = await axios.post(url, finalPayload, { timeout: 5000 });
    statusCode = response.status;
    success = response.status >= 200 && response.status < 300;
    
    // Stringify/truncate response body to fit in db column
    responsePayload = typeof response.data === 'object' 
      ? JSON.stringify(response.data) 
      : String(response.data);
    if (responsePayload.length > 5000) {
      responsePayload = responsePayload.substring(0, 5000) + '... (truncated)';
    }
  } catch (err) {
    errorMessage = err.message;
    if (err.response) {
      statusCode = err.response.status;
      responsePayload = typeof err.response.data === 'object'
        ? JSON.stringify(err.response.data)
        : String(err.response.data);
    }
  }

  const durationMs = Date.now() - startTime;

  existingLogId = await logWebhookAttempt(existingLogId, {
    topicId,
    messageId,
    url,
    statusCode,
    requestPayload: JSON.stringify(finalPayload),
    responsePayload,
    durationMs,
    success,
    errorMessage,
    attempt
  });

  // Handle retries on failure
  if (!success && attempt < MAX_ATTEMPTS) {
    const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1); // 2s, 4s, etc.
    console.log(`Webhook to ${url} failed. Scheduling attempt ${attempt + 1} in ${delay}ms...`);
    setTimeout(() => {
      dispatchSingleWebhook(topicId, messageId, url, finalPayload, attempt + 1, existingLogId).catch(err => {
        console.error(`Unhandled error in retried webhook to ${url}:`, err);
      });
    }, delay);
  }
}

/**
 * Dispatch webhooks for a topic and payload, logging attempts in DB and retrying on failure.
 *
 * @param {object} topic 
 * @param {number} messageId 
 * @param {object} payload 
 */
export async function queueWebhookDispatch(topic, messageId, payload) {
  if (!topic.webhooks || topic.webhooks.length === 0) return;

  // Dispatch all concurrently in the background
  topic.webhooks.forEach(url => {
    dispatchSingleWebhook(topic.id, messageId, url, payload, 1).catch(err => {
      console.error(`Unhandled error dispatching webhook to ${url}:`, err);
    });
  });
}
