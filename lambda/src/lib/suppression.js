/**
 * src/lib/suppression.js
 * Read/write the global suppression list in DynamoDB.
 *
 * An address is suppressed when:
 *   - SES reports a hard bounce
 *   - SES reports a complaint (spam report)
 *   - The recipient clicks the unsubscribe link
 *   - An operator manually suppresses an address
 *
 * Suppression is checked before every send; suppressed addresses are silently
 * skipped and their recipient row is updated to status=SUPPRESSED.
 */
'use strict';

const { keys, get, put, batchWrite } = require('./dynamo');
const logger = require('./logger');

/**
 * Check if a single email is suppressed.
 * @returns {boolean}
 */
async function isSuppressed(email) {
  const { Item } = await get(keys.suppress(email.toLowerCase()));
  return !!Item;
}

/**
 * Bulk-check a list of emails.
 * @returns {Set<string>} set of suppressed emails (normalised lowercase)
 */
async function bulkCheck(emails) {
  // DynamoDB BatchGet is limited to 100 items; query individually for suppression
  // (suppression list is typically small relative to campaign lists in practice).
  // For very large lists the worker should cache this per-invocation.
  const results = await Promise.all(
    emails.map(e => get(keys.suppress(e.toLowerCase())))
  );
  const suppressed = new Set();
  results.forEach((r, i) => { if (r.Item) suppressed.add(emails[i].toLowerCase()); });
  return suppressed;
}

/**
 * Add one address to the suppression list.
 * @param {string} email
 * @param {'bounce'|'complaint'|'unsubscribe'|'manual'} reason
 * @param {string} [campaignId]
 */
async function suppress(email, reason, campaignId) {
  const norm = email.toLowerCase();
  await put({
    ...keys.suppress(norm),
    email: norm,
    reason,
    campaignId: campaignId || null,
    suppressedAt: new Date().toISOString(),
    ttl: null, // permanent by default; set a numeric Unix epoch to auto-expire
  });
  logger.info('Address suppressed', { email: norm, reason, campaignId });
}

/**
 * Remove an address from the suppression list (operator action only).
 */
async function unsuppress(email) {
  const { remove } = require('./dynamo');
  await remove(keys.suppress(email.toLowerCase()));
  logger.info('Address removed from suppression list', { email: email.toLowerCase() });
}

/**
 * Batch-suppress multiple addresses (e.g. from a bounce batch notification).
 */
async function bulkSuppress(emails, reason, campaignId) {
  const now = new Date().toISOString();
  const requests = emails.map(e => ({
    PutRequest: {
      Item: {
        ...keys.suppress(e.toLowerCase()),
        email: e.toLowerCase(),
        reason,
        campaignId: campaignId || null,
        suppressedAt: now,
        ttl: null,
      },
    },
  }));
  await batchWrite(requests);
  logger.info('Bulk suppression complete', { count: emails.length, reason });
}

module.exports = { isSuppressed, bulkCheck, suppress, unsuppress, bulkSuppress };
