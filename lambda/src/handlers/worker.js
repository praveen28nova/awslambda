/**
 * src/handlers/worker.js
 * SQS Worker Lambda — dequeues campaign send jobs and delivers email via SES.
 *
 * Architecture:
 *   API → CAMPAIGN_QUEUE (FIFO) → this worker → SES
 *
 * Idempotency:
 *   Each recipient row has a `status` field. On every invocation we check the
 *   current status BEFORE calling SES. If status is already SENT/DELIVERED/FAILED,
 *   we skip it. This means retries are safe — SES is only called once per recipient.
 *
 * Throttling:
 *   SEND_RATE_PER_SEC env var limits throughput. Worker sleeps between micro-batches
 *   to stay inside SES account quota (default sandbox: 1/sec, production: 14/sec+).
 *
 * Dead-letter:
 *   After MAX_RECEIVE_COUNT failures SQS moves the message to CAMPAIGN_DLQ.
 *   The dlqProcessor handler (below) records the failure and marks the campaign FAILED.
 *
 * Pause/Cancel:
 *   Before processing each recipient batch, the worker re-reads campaign status.
 *   If status is PAUSED or CANCELLED, it stops processing (messages stay in queue
 *   or are deleted) and exits gracefully.
 */
'use strict';

const { SendEmailCommand } = require('@aws-sdk/client-ses');
const { ses } = require('../lib/clients');
const { keys, get, update, query } = require('../lib/dynamo');
const { isSuppressed } = require('../lib/suppression');
const logger = require('../lib/logger');

const SEND_RATE     = parseInt(process.env.SEND_RATE_PER_SEC || '10', 10);
const BATCH_SIZE    = parseInt(process.env.WORKER_BATCH_SIZE || '10', 10);
const APP_BASE_URL  = process.env.APP_BASE_URL || 'https://example.com';
const UNSUBSCRIBE_ENDPOINT = `${APP_BASE_URL}/unsubscribe`;

// ── Main SQS handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  for (const record of event.Records) {
    let payload;
    try {
      payload = JSON.parse(record.body);
    } catch {
      logger.error('Invalid SQS message body — skipping', { messageId: record.messageId });
      continue;
    }

    const { campaignId, accountId, action } = payload;
    logger.setContext({ campaignId, accountId });

    if (action !== 'SEND') {
      logger.warn('Unknown action in SQS message', { action });
      continue;
    }

    await processCampaign(campaignId, accountId);
  }
};

// ── DLQ processor ─────────────────────────────────────────────────────────────
exports.dlqProcessor = async (event) => {
  for (const record of event.Records) {
    let payload;
    try { payload = JSON.parse(record.body); } catch { continue; }
    const { campaignId } = payload;
    if (!campaignId) continue;

    logger.error('Campaign message exhausted retries — marking FAILED', { campaignId });
    const now = new Date().toISOString();
    await update(
      keys.campaign(campaignId),
      'SET #s = :s, updatedAt = :u',
      { '#s': 'status' },
      { ':s': 'FAILED', ':u': now }
    ).catch(e => logger.error('Could not mark campaign FAILED', { campaignId, error: e.message }));
  }
};

// ── Core sending logic ─────────────────────────────────────────────────────────
async function processCampaign(campaignId, accountId) {
  // 1. Load campaign (contains subject, from, body)
  const { Item: campaign } = await get(keys.campaign(campaignId));
  if (!campaign) { logger.error('Campaign not found', { campaignId }); return; }
  if (!['SENDING', 'SCHEDULED'].includes(campaign.status)) {
    logger.info('Campaign not in sendable state — aborting worker', { status: campaign.status });
    return;
  }

  // Mark campaign as SENDING (idempotent — ok if already SENDING)
  if (campaign.status !== 'SENDING') {
    await update(
      keys.campaign(campaignId),
      'SET #s = :s, updatedAt = :u',
      { '#s': 'status' },
      { ':s': 'SENDING', ':u': new Date().toISOString() }
    );
  }

  const fromAddress = `${campaign.fromName} <${campaign.fromEmail}>`;

  // 2. Paginate through PENDING recipients
  let lastKey;
  let totalSent = 0;
  let totalFailed = 0;

  do {
    // Re-check status before each page to respect pause/cancel
    const { Item: fresh } = await get(keys.campaign(campaignId));
    if (!fresh || !['SENDING'].includes(fresh.status)) {
      logger.info('Campaign paused or cancelled mid-run — stopping worker', { campaignId });
      return;
    }

    const page = await query({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression:       '#s = :pending',
      ExpressionAttributeValues: {
        ':pk':      `CAMPAIGN#${campaignId}`,
        ':prefix':  'RECIPIENT#',
        ':pending': 'PENDING',
      },
      ExpressionAttributeNames: { '#s': 'status' },
      Limit:             BATCH_SIZE,
      ExclusiveStartKey: lastKey,
    });

    lastKey = page.LastEvaluatedKey;
    const recipients = page.Items || [];

    if (recipients.length === 0) break;

    // 3. Send each recipient in the page (sequentially for rate control)
    for (const recipient of recipients) {
      const { email } = recipient;

      // ── Idempotency guard: skip if already processed ──────────────────────
      const { Item: current } = await get(keys.recipient(campaignId, email));
      if (!current || current.status !== 'PENDING') {
        logger.debug('Skipping non-PENDING recipient', { email: '[REDACTED]' });
        continue;
      }

      // ── Suppression check (applied here in case address was suppressed after add) ─
      const suppressed = await isSuppressed(email);
      if (suppressed) {
        await markRecipient(campaignId, email, 'SUPPRESSED', null);
        continue;
      }

      // ── Build and send the email ──────────────────────────────────────────
      try {
        const unsubUrl = buildUnsubscribeUrl(email, campaignId);
        const messageId = await sendEmail({ campaign, fromAddress, to: email, unsubUrl });

        await markRecipient(campaignId, email, 'SENT', messageId);
        totalSent++;
      } catch (err) {
        logger.error('SES send failed', { error: err.message, code: err.name });
        await markRecipient(campaignId, email, 'FAILED', null, err.message);
        totalFailed++;
      }

      // ── Rate limiting ─────────────────────────────────────────────────────
      await sleep(1000 / SEND_RATE);
    }
  } while (lastKey);

  // 4. Check if all recipients are processed → mark COMPLETED
  const pending = await query({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#s = :pending',
    ExpressionAttributeValues: {
      ':pk': `CAMPAIGN#${campaignId}`,
      ':prefix': 'RECIPIENT#',
      ':pending': 'PENDING',
    },
    ExpressionAttributeNames: { '#s': 'status' },
    Select: 'COUNT',
  });

  if ((pending.Count || 0) === 0) {
    await update(
      keys.campaign(campaignId),
      'SET #s = :s, updatedAt = :u, completedAt = :c',
      { '#s': 'status' },
      { ':s': 'COMPLETED', ':u': new Date().toISOString(), ':c': new Date().toISOString() }
    );
    logger.info('Campaign completed', { campaignId, totalSent, totalFailed });
  } else {
    logger.info('Worker page complete — more pending recipients remain', { campaignId, totalSent, totalFailed });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendEmail({ campaign, fromAddress, to, unsubUrl }) {
  // Inject one-click unsubscribe link into HTML body
  const unsubHtml  = `<br><br><hr><p style="font-size:12px;color:#999;">
    <a href="${unsubUrl}">Unsubscribe</a> | You received this because you opted in.</p>`;
  const htmlWithUnsub = (campaign.htmlBody || '') + unsubHtml;

  const textUnsub = `\n\n---\nUnsubscribe: ${unsubUrl}\nYou received this because you opted in.`;
  const textBody  = campaign.textBody ? campaign.textBody + textUnsub : undefined;

  const params = {
    Source:      fromAddress,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: campaign.subject, Charset: 'UTF-8' },
      Body:    {
        Html: { Data: htmlWithUnsub, Charset: 'UTF-8' },
        ...(textBody ? { Text: { Data: textBody, Charset: 'UTF-8' } } : {}),
      },
    },
    ...(campaign.replyTo ? { ReplyToAddresses: [campaign.replyTo] } : {}),
    // SES configuration set for bounce/complaint/delivery tracking
    ConfigurationSetName: process.env.SES_CONFIGURATION_SET || undefined,
    Tags: [
      { Name: 'campaignId', Value: campaign.campaignId },
      { Name: 'accountId',  Value: campaign.accountId },
    ],
  };

  const res = await ses.send(new SendEmailCommand(params));
  return res.MessageId;
}

async function markRecipient(campaignId, email, status, messageId, errorMsg) {
  const now = new Date().toISOString();
  const exprParts   = ['#s = :s', 'updatedAt = :u'];
  const names       = { '#s': 'status' };
  const values      = { ':s': status, ':u': now };

  if (messageId)  { exprParts.push('messageId = :mid'); values[':mid'] = messageId; }
  if (errorMsg)   { exprParts.push('errorMsg = :err');  values[':err'] = errorMsg; }
  if (status === 'SENT') { exprParts.push('sentAt = :sa'); values[':sa'] = now; }

  await update(
    keys.recipient(campaignId, email),
    `SET ${exprParts.join(', ')}`,
    names,
    values
  );

  // Update campaign counters
  const counterMap = { SENT: 'sentCount', FAILED: 'failedCount', SUPPRESSED: 'suppressedCount' };
  const counter = counterMap[status];
  if (counter) {
    await update(
      keys.campaign(campaignId),
      `SET ${counter} = if_not_exists(${counter}, :zero) + :one`,
      {},
      { ':zero': 0, ':one': 1 }
    );
  }
}

function buildUnsubscribeUrl(email, campaignId) {
  const token = Buffer.from(JSON.stringify({ email, campaignId })).toString('base64url');
  return `${UNSUBSCRIBE_ENDPOINT}?token=${token}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}
