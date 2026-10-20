/**
 * src/handlers/campaigns.js
 * Campaign CRUD API — Create, Get, List, Update status (schedule/pause/resume/cancel).
 *
 * Routes (all require auth):
 *   POST   /campaigns                — create a campaign
 *   GET    /campaigns                — list campaigns for account
 *   GET    /campaigns/{id}           — get single campaign
 *   PATCH  /campaigns/{id}/status    — transition status
 *   DELETE /campaigns/{id}           — soft-delete (only DRAFT or CANCELLED)
 *
 * Campaign status machine:
 *   DRAFT → SCHEDULED → SENDING → PAUSED → SENDING (resume)
 *                               → COMPLETED
 *                               → CANCELLED
 *   DRAFT → CANCELLED
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const { withAuth, assertCampaignOwner } = require('../lib/auth');
const { keys, put, update, remove, query } = require('../lib/dynamo');
const { ok, created, noContent, badRequest, notFound, conflict, serverError } = require('../lib/response');
const { missingFields } = require('../lib/validate');
const { sqs } = require('../lib/clients');
const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const logger = require('../lib/logger');

const MAX_SUBJECT_LEN  = 998; // RFC 2822
const MAX_BODY_LEN     = 500_000; // ~500 KB
const MAX_RECIPIENTS   = 100_000;

// ── Status transitions ─────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS = {
  DRAFT:     ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['SENDING', 'CANCELLED'],
  SENDING:   ['PAUSED', 'CANCELLED', 'COMPLETED'],
  PAUSED:    ['SENDING', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

// ── Handlers ───────────────────────────────────────────────────────────────────

exports.create = withAuth(async (event, _ctx, { accountId }) => {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return badRequest('Invalid JSON'); }

  const missing = missingFields(body, ['subject', 'fromEmail', 'fromName', 'htmlBody']);
  if (missing.length) return badRequest(`Missing required fields: ${missing.join(', ')}`);

  const { subject, fromEmail, fromName, replyTo, htmlBody, textBody, scheduledAt } = body;

  if (typeof subject !== 'string' || subject.length > MAX_SUBJECT_LEN)
    return badRequest(`'subject' must be a string ≤ ${MAX_SUBJECT_LEN} chars`);
  if (typeof htmlBody !== 'string' || htmlBody.length > MAX_BODY_LEN)
    return badRequest(`'htmlBody' must be a string ≤ ${MAX_BODY_LEN} bytes`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail))
    return badRequest("'fromEmail' must be a valid email address");
  if (scheduledAt && isNaN(Date.parse(scheduledAt)))
    return badRequest("'scheduledAt' must be an ISO 8601 timestamp");

  const campaignId = uuidv4();
  const now = new Date().toISOString();

  const item = {
    ...keys.campaign(campaignId),
    accountId,
    campaignId,
    subject,
    fromEmail,
    fromName,
    replyTo:     replyTo || null,
    // NOTE: body is stored so workers can fetch it — never logged.
    htmlBody,
    textBody:    textBody || null,
    scheduledAt: scheduledAt || null,
    status:      scheduledAt ? 'SCHEDULED' : 'DRAFT',
    recipientCount: 0,
    sentCount:    0,
    deliveredCount: 0,
    bouncedCount:  0,
    complainedCount: 0,
    failedCount:   0,
    createdAt:   now,
    updatedAt:   now,
    // GSI keys for listing by account+status
    GSI1PK: `ACCOUNT#${accountId}`,
    GSI1SK: `STATUS#${scheduledAt ? 'SCHEDULED' : 'DRAFT'}#CREATED#${now}`,
  };

  await put(item, 'attribute_not_exists(PK)');
  logger.info('Campaign created', { campaignId, accountId, status: item.status });

  // Return item WITHOUT body content
  const { htmlBody: _h, textBody: _t, ...safeItem } = item;
  return created({ campaign: safeItem });
});


exports.get = withAuth(async (event, _ctx, { accountId }) => {
  const campaignId = event.pathParameters?.id;
  if (!campaignId) return badRequest('Missing campaign id');

  const { campaign, response } = await assertCampaignOwner(campaignId, accountId);
  if (response) return response;

  const { htmlBody, textBody, ...safe } = campaign;
  return ok({ campaign: safe });
});


exports.list = withAuth(async (event, _ctx, { accountId }) => {
  const qs   = event.queryStringParameters || {};
  const limit = Math.min(parseInt(qs.limit || '20', 10), 100);
  const nextToken = qs.nextToken ? JSON.parse(Buffer.from(qs.nextToken, 'base64').toString()) : undefined;

  const result = await query({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}` },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: nextToken,
  });

  const items = (result.Items || []).map(({ htmlBody, textBody, ...safe }) => safe);
  const next  = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : null;

  return ok({ campaigns: items, count: items.length, nextToken: next });
});


exports.updateStatus = withAuth(async (event, _ctx, { accountId }) => {
  const campaignId = event.pathParameters?.id;
  if (!campaignId) return badRequest('Missing campaign id');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return badRequest('Invalid JSON'); }

  const { status } = body;
  if (!status) return badRequest("'status' is required");

  const { campaign, response } = await assertCampaignOwner(campaignId, accountId);
  if (response) return response;

  const allowed = ALLOWED_TRANSITIONS[campaign.status] || [];
  if (!allowed.includes(status)) {
    return conflict(`Cannot transition from ${campaign.status} to ${status}. Allowed: ${allowed.join(', ') || 'none'}`);
  }

  // If transitioning to SENDING (from SCHEDULED or PAUSED), enqueue the campaign
  if (status === 'SENDING') {
    await sqs.send(new SendMessageCommand({
      QueueUrl:               process.env.CAMPAIGN_QUEUE_URL,
      MessageBody:            JSON.stringify({ campaignId, accountId, action: 'SEND' }),
      MessageGroupId:         accountId,          // FIFO queue — one at a time per account
      MessageDeduplicationId: `${campaignId}-${Date.now()}`,
    }));
  }

  const now = new Date().toISOString();
  const { Attributes } = await update(
    keys.campaign(campaignId),
    'SET #s = :s, updatedAt = :u, GSI1SK = :gsk',
    { '#s': 'status' },
    { ':s': status, ':u': now, ':gsk': `STATUS#${status}#CREATED#${campaign.createdAt}` },
  );

  logger.info('Campaign status updated', { campaignId, from: campaign.status, to: status });
  const { htmlBody, textBody, ...safe } = Attributes;
  return ok({ campaign: safe });
});


exports.deleteCampaign = withAuth(async (event, _ctx, { accountId }) => {
  const campaignId = event.pathParameters?.id;
  if (!campaignId) return badRequest('Missing campaign id');

  const { campaign, response } = await assertCampaignOwner(campaignId, accountId);
  if (response) return response;

  if (!['DRAFT', 'CANCELLED'].includes(campaign.status)) {
    return conflict(`Only DRAFT or CANCELLED campaigns can be deleted (current: ${campaign.status})`);
  }

  await remove(keys.campaign(campaignId));
  logger.info('Campaign deleted', { campaignId, accountId });
  return noContent();
});
