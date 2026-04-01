'use strict';

const pino = require('pino');
const path = require('path');
const fs = require('fs');

let _logger = null;

/**
 * Initialize the global logger.
 * Must be called once from main process after app is ready.
 * Uses pino.destination (sync, no worker_threads) for Electron compatibility.
 * @param {string} userDataPath - app.getPath('userData')
 */
function initLogger(userDataPath) {
  const isDev = process.env.NODE_ENV !== 'production';
  const env = isDev ? 'development' : 'production';

  let destination;

  if (isDev) {
    // Dev: write JSON to stderr (fd 2), sync-safe in Electron
    destination = pino.destination(2);
  } else {
    // Prod: write JSON to daily log file
    const logDir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`);
    destination = pino.destination({ dest: logFile, append: true, sync: true });
  }

  _logger = pino(
    {
      level: isDev ? 'debug' : 'info',
      base: {
        service: 'start-everything',
        env,
        pid: process.pid,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination
  );

  return _logger;
}

/**
 * Get the global logger (must call initLogger first).
 */
function getLogger() {
  if (!_logger) {
    // Fallback: stderr logger so callers never crash before initLogger
    _logger = pino({ level: 'debug' }, pino.destination(2));
  }
  return _logger;
}

/**
 * Return a child logger with a bound trace_id.
 * @param {string} traceId
 */
function withTrace(traceId) {
  return getLogger().child({ trace_id: traceId });
}

module.exports = { initLogger, getLogger, withTrace };
