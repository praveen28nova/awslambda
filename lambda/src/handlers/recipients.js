/**
 * src/handlers/recipients.js
 * Recipient management for a campaign.
 *
 * Routes (all require auth + campaign ownership):
 *   POST /campaigns/{id}/recipients          — add recipients (JSON array, max 1 000 per call)
 *   POST /campaigns/{id}/recipients/csv      — CSV upload (multipart base64, max 5 MB)
 *   GET  /campaigns/{id}/recipients          — list with pagination
 *
 * Rules:
 *   - Only accepts opted-in addresses (caller asserts consent, documented in API contract).
 *   - Validates email format, deduplicates, normalises to lowercase.
 *   - Checks global suppression list and rejects suppressed addresses immediately.
 *   - Campaign must be in DRAFT or SCHEDULED status to add recipients.
 *   - Max total recipients per campaign: 100 000.
 */
'use strict';

const { withAuth, assertCampaignOwner } = require('../lib/auth');
const { keys, put, query, update, batchWrite } = require('../lib/dynamo');
const { ok, created, badRequest, conflict } = require('../lib/response');
const { filterEmails } = require('../lib/validate');
const { bulkCheck } = require('../lib/suppression');
const { parse: csvParse } = require('csv-parse/sync');
const logger = require('../lib/logger');

const MAX_BATCH    = 1_000;
const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_TOTAL    = 100_000;

// ── Add recipients (JSON) ──────────────────────────────────────────────────────
exports.addRecipients = withAuth(async (event, _ctx, { accountId }) => {
  const campaignId = event.pathParameters?.id;
  if (!campaignId) return badRequest('Missing campaign id');

  const { campaign, response } = await assertCampaignOwner(campaignId, accountId);
  if (response) return response;

  if (!['DRAFT', 'SCHEDULED'].includes(campaign.status)) {
    return conflict(`Recipients can only be added to DRAFT or SCHEDULED campaigns (current: ${campaign.status})`);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return badRequest('Invalid JSON'); }

  const raw = body.recipients;
  if (!Array.isArray(raw) || raw.length === 0) return badRequest("'recipients' must be a non-empty array");
  if (raw.length > MAX_BATCH) return badRequest(`Max ${MAX_BATCH} recipients per call`);

  return _processEmails(campaignId, accountId, campaign, raw.map(r => (typeof r === 'string' ? r : r?.email)));
});

// ── Add recipients (CSV) ───────────────────────────────────────────────────────
exports.addRecipientsCSV = withAuth(async (event, _ctx, { accountId }) => {
  const campaignId = event.pathParameters?.id;
  if (!campaignId) return badRequest('Missing campaign id');

  const { campaign, response } = await assertCampaignOwner(campaignId, accountId);
  if (response) return response;

  if (!['DRAFT', 'SCHEDULED'].includes(campaign.status)) {
    return conflict(`CSV import only allowed for DRAFT or SCHEDULED campaigns (current: ${campaign.status})`);
  }

  // API Gateway base64-encodes binary bodies
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '');

  if (rawBody.length > MAX_CSV_BYTES) return badRequest(`CSV must be ≤ ${MAX_CSV_BYTES / 1024 / 1024} MB`);

  let records;
  try {
    records = csvParse(rawBody, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return badRequest(`CSV parse error: ${e.message}`);
  }

  // Accept 'email' or 'Email' column
  const emails = records
    .map(r => r.email || r.Email || r.EMAIL || '')
    .filter(Boolean);

  if (emails.length === 0) return badRequest('CSV must contain an "email" column with at least one row');

  return _processEmails(campaignId, accountId, campaign, emails);
});

// ── List recipients ────────────────────────────────────────────────────────────
exports.listRecipients = withAuth(async (event, _ctx, { accountId }) => {
  const campaignId = event.pathParameters?.id;
  if (!campaignId) return badRequest('Missing campaign id');

  const { response } = await assertCampaignOwner(campaignId, accountId);
  if (response) return response;

  const qs    = event.queryStringParameters || {};
  const limit = Math.min(parseInt(qs.limit || '50', 10), 500);
  const nextToken = qs.nextToken ? JSON.parse(Buffer.from(qs.nextToken, 'base64').toString()) : undefined;

  const result = await query({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CAMPAIGN#${campaignId}`, ':prefix': 'RECIPIENT#' },
    Limit: limit,
    ExclusiveStartKey: nextToken,
  });

  const next = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : null;

  return ok({ recipients: result.Items || [], count: result.Count, nextToken: next });
});

// ── Shared processing ──────────────────────────────────────────────────────────
async function _processEmails(campaignId, accountId, campaign, rawEmails) {
  const { valid, invalid } = filterEmails(rawEmails);

  if (valid.length === 0) {
    return badRequest('No valid email addresses found', { invalid: invalid.slice(0, 20) });
  }

  // Enforce per-campaign cap
  const current = campaign.recipientCount || 0;
  if (current + valid.length > MAX_TOTAL) {
    return conflict(`Adding ${valid.length} would exceed the ${MAX_TOTAL} recipient limit (current: ${current})`);
  }

  // Filter out suppressed addresses
  const suppressed = await bulkCheck(valid);
  const allowed    = valid.filter(e => !suppressed.has(e));
  const skippedSuppressed = valid.filter(e => suppressed.has(e));

  const now = new Date().toISOString();

  // Batch-write recipient rows (25-item chunks handled by batchWrite)
  const requests = allowed.map(email => ({
    PutRequest: {
      Item: {
        ...keys.recipient(campaignId, email),
        accountId,
        campaignId,
        email,
        status:    'PENDING',
        addedAt:   now,
        updatedAt: now,
      },
    },
  }));

  await batchWrite(requests);

  // Increment recipientCount on the campaign
  await update(
    keys.campaign(campaignId),
    'SET recipientCount = recipientCount + :n, updatedAt = :u',
    {},
    { ':n': allowed.length, ':u': now }
  );

  logger.info('Recipients added', {
    campaignId,
    added: allowed.length,
    skippedInvalid: invalid.length,
    skippedSuppressed: skippedSuppressed.length,
  });

  return created({
    added:             allowed.length,
    skippedInvalid:    invalid.length,
    skippedSuppressed: skippedSuppressed.length,
    total:             current + allowed.length,
    ...(invalid.length > 0 ? { sampleInvalid: invalid.slice(0, 5) } : {}),
  });
}
