/**
 * src/lib/validate.js
 * Shared input validation utilities.
 */
'use strict';

// RFC 5322-ish email regex — rejects most obviously bad addresses
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim()) && email.length <= 254;
}

function normaliseEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * Validate and normalise an array of raw email strings.
 * Returns { valid: string[], invalid: string[] }
 */
function filterEmails(rawList) {
  const valid   = [];
  const invalid = [];
  const seen    = new Set();
  for (const raw of rawList) {
    if (!isValidEmail(raw)) { invalid.push(raw); continue; }
    const n = normaliseEmail(raw);
    if (seen.has(n)) continue; // deduplicate
    seen.add(n);
    valid.push(n);
  }
  return { valid, invalid };
}

/**
 * Assert that required fields exist in an object.
 * @returns {string[]} list of missing field names
 */
function missingFields(obj, fields) {
  return fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '');
}

module.exports = { isValidEmail, normaliseEmail, filterEmails, missingFields };
