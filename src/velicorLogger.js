import axios from 'axios';
import { Writable } from 'node:stream';

class VelicorStream extends Writable {
  constructor(options = {}) {
    super(options);
    this.velicorUrl = process.env.VELICOR_URL || process.env.velicor_url || '';
    this.apiKey = process.env.VELICOR_API_KEY || process.env.velicor_api_key || '';
    this.serviceName = process.env.VELICOR_SERVICE_NAME || process.env.velicor_service_name || 'beacon';
    this.batchSize = options.batchSize || 50;
    this.flushInterval = options.flushInterval || 2000; // 2 seconds
    this.queue = [];
    this.timer = null;
    this._isSending = false;

    if (this.velicorUrl && this.apiKey) {
      this.client = axios.create({
        baseURL: this.velicorUrl,
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 3000
      });
      this.startTimer();
    }
  }

  _write(chunk, encoding, callback) {
    const rawMsg = chunk.toString();
    // Output directly to standard out so logs are still visible in standard containers/console
    process.stdout.write(rawMsg);

    if (!this.velicorUrl || !this.apiKey) {
      return callback();
    }

    try {
      const parsed = JSON.parse(rawMsg);
      
      // Map Pino levels: 10/20=DEBUG, 30=INFO, 40=WARN, 50=ERROR, 60=FATAL
      const levelMap = {
        10: 'DEBUG',
        20: 'DEBUG',
        30: 'INFO',
        40: 'WARN',
        50: 'ERROR',
        60: 'FATAL'
      };
      
      const levelNum = parsed.level || 30;
      const levelStr = levelMap[levelNum] || 'INFO';

      // Skip debug logs to prevent excessive database volume
      if (levelNum < 30) {
        return callback();
      }

      // Format Pino timestamp to ISO String
      const timestamp = parsed.time 
        ? new Date(parsed.time).toISOString() 
        : new Date().toISOString();

      const logPayload = {
        timestamp,
        level: levelStr,
        message: parsed.msg || parsed.message || 'No log message',
        metadata: {
          pid: parsed.pid,
          hostname: parsed.hostname,
          reqId: parsed.reqId,
          res: parsed.res,
          req: parsed.req,
          responseTime: parsed.responseTime,
          err: parsed.err ? {
            type: parsed.err.type,
            message: parsed.err.message,
            stack: parsed.err.stack,
            code: parsed.err.code
          } : undefined
        }
      };

      this.queue.push(logPayload);

      if (this.queue.length >= this.batchSize) {
        this.flush();
      }
    } catch (e) {
      // Ignore JSON parse errors for non-JSON log chunks
      console.debug(`VelicorLogger: Skipped parsing non-JSON log chunk: ${e.message}`);
    }

    callback();
  }

  startTimer() {
    this.timer = setInterval(() => {
      if (this.queue.length > 0 && !this._isSending) {
        this.flush().catch(err => {
          console.error(`VelicorLogger: Failed to flush logs.`, err);
        });
      }
    }, this.flushInterval);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  async flush() {
    if (this._isSending || this.queue.length === 0) return;
    this._isSending = true;

    const batch = [...this.queue];
    this.queue = [];

    try {
      await this.client.post('/api/v1/ingest', batch);
    } catch (err) {
      // Output error but do not crash the application process
      console.error(`❌ VelicorLogger Error: Failed to ingest logs to Velicor. ${err.message}`);
    } finally {
      this._isSending = false;
    }
  }
}

export const createVelicorLogger = (pinoOptions = {}) => {
  const stream = new VelicorStream();
  return {
    ...pinoOptions,
    stream
  };
};
