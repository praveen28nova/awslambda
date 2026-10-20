/**
 * src/lib/logger.js
 * Structured JSON logger.
 *
 * Rules:
 *  - Never log email body content.
 *  - Never log credentials, tokens, or API keys.
 *  - Only log recipient email addresses at DEBUG level (disabled in prod).
 *  - Always include requestId and accountId for traceability.
 */
'use strict';

const LEVEL_MAP = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVEL_MAP[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVEL_MAP.info;

let _ctx = {};

function setContext(ctx) {
  _ctx = { ..._ctx, ...ctx };
}

function log(level, message, meta = {}) {
  if (LEVEL_MAP[level] < MIN_LEVEL) return;

  // Strip any accidental sensitive fields
  const { password, token, apiKey, body, htmlBody, textBody, ...safeMeta } = meta; // eslint-disable-line no-unused-vars

  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ..._ctx,
    ...safeMeta,
  };

  // Use console.error for warn/error so CloudWatch Insights can filter by severity
  if (level === 'error' || level === 'warn') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

module.exports = {
  setContext,
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
