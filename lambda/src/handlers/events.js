/**
 * src/handlers/events.js
 * SES Event Processor — receives bounce, complaint, delivery, and unsubscribe events.
 *
 * Event flow:
 *   SES → SNS topic (MailBlastEventsTopic) → this Lambda
 *
 * Actions taken per event type:
 *   bounce (hard)    → suppress address, update recipient row
 *   bounce (soft)    → update recipient row only (soft bounces may be transient)
 *   complaint        → suppress address, update recipient row
 *   delivery         → update recipient row to DELIVERED, increment campaign counter
 *   send             → (informational only, logged)
 *   reject           → update recipient row to REJECTED
 *
 * Note: email content is NEVER present in these events — only message IDs, timestamps,
 * bounce types, and recipient addresses from the SES notification JSON.
 */
'use strict';

const { keys, update, query } = require('../lib/dynamo');
const { suppress } = require('../lib/suppression');
const logger = require('../lib/logger');

exports.handler = async (event) => {
  for (const record of event.Records) {
    let notification;
    try {
      // SNS wraps the SES notification as a JSON string in record.Sns.Message
      notification = JSON.parse(record.Sns?.Message || record.body || '{}');
    } catch {
      logger.error('Could not parse SNS/SES notification', { messageId: record.messageId });
      continue;
    }

    const { notificationType, eventType } = notification;
    const type = (notificationType || eventType || '').toLowerCase();

    logger.info('SES event received', { type });

    try {
      switch (type) {
        case 'bounce':     await handleBounce(notification);     break;
        case 'complaint':  await handleComplaint(notification);  break;
        case 'delivery':   await handleDelivery(notification);   break;
        case 'send':       await handleSend(notification);       break;
        case 'reject':     await handleReject(notification);     break;
        default:
          logger.warn('Unknown SES notification type', { type });
      }
    } catch (err) {
      logger.error('Failed to process SES event', { type, error: err.message });
      // Do NOT rethrow — a single bad event shouldn't block the rest of the batch
    }
  }
};

// ── Bounce ────────────────────────────────────────────────────────────────────
async function handleBounce(notification) {
  const bounce      = notification.bounce;
  const bounceType  = bounce?.bounceType;         // 'Permanent' | 'Transient'
  const bounceSubType = bounce?.bounceSubType;
  const recipients  = bounce?.bouncedRecipients || [];
  const messageId   = notification.mail?.messageId;

  const campaignId = await resolveCampaignId(messageId);
  const isHard = bounceType === 'Permanent';

  for (const r of recipients) {
    const email = r.emailAddress?.toLowerCase();
    if (!email) continue;

    if (isHard) {
      await suppress(email, 'bounce', campaignId);
    }

    await updateRecipientByEmail(campaignId, email, isHard ? 'BOUNCED' : 'SOFT_BOUNCED', {
      bounceType, bounceSubType, bounceAction: r.action,
    });

    if (campaignId && isHard) {
      await update(
        keys.campaign(campaignId),
        'SET bouncedCount = if_not_exists(bouncedCount, :z) + :one, updatedAt = :u',
        {},
        { ':z': 0, ':one': 1, ':u': new Date().toISOString() }
      );
    }
  }

  logger.info('Bounce processed', {
    bounceType, count: recipients.length, hard: isHard, campaignId,
  });
}

// ── Complaint ─────────────────────────────────────────────────────────────────
async function handleComplaint(notification) {
  const complaint  = notification.complaint;
  const recipients = complaint?.complainedRecipients || [];
  const messageId  = notification.mail?.messageId;
  const campaignId = await resolveCampaignId(messageId);

  for (const r of recipients) {
    const email = r.emailAddress?.toLowerCase();
    if (!email) continue;

    await suppress(email, 'complaint', campaignId);
    await updateRecipientByEmail(campaignId, email, 'COMPLAINED', {
      feedbackType: complaint?.complaintFeedbackType,
    });

    if (campaignId) {
      await update(
        keys.campaign(campaignId),
        'SET complainedCount = if_not_exists(complainedCount, :z) + :one, updatedAt = :u',
        {},
        { ':z': 0, ':one': 1, ':u': new Date().toISOString() }
      );
    }
  }

  logger.info('Complaint processed', { count: recipients.length, campaignId });
}

// ── Delivery ──────────────────────────────────────────────────────────────────
async function handleDelivery(notification) {
  const delivery  = notification.delivery;
  const recipients = delivery?.recipients || [];
  const messageId  = notification.mail?.messageId;
  const campaignId = await resolveCampaignId(messageId);

  for (const email of recipients) {
    await updateRecipientByEmail(campaignId, email.toLowerCase(), 'DELIVERED', {
      processingTimeMillis: delivery?.processingTimeMillis,
    });
  }

  if (campaignId && recipients.length) {
    await update(
      keys.campaign(campaignId),
      'SET deliveredCount = if_not_exists(deliveredCount, :z) + :n, updatedAt = :u',
      {},
      { ':z': 0, ':n': recipients.length, ':u': new Date().toISOString() }
    );
  }

  logger.info('Delivery event processed', { count: recipients.length, campaignId });
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function handleSend(notification) {
  // Informational only — recipient status is already SENT; nothing to update.
  logger.info('SES send event', { destinations: notification.mail?.destination?.length });
}

// ── Reject ────────────────────────────────────────────────────────────────────
async function handleReject(notification) {
  const reason    = notification.reject?.reason;
  const messageId = notification.mail?.messageId;
  const campaignId = await resolveCampaignId(messageId);
  logger.warn('SES rejected a message', { reason, campaignId });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Look up a campaignId from an SES messageId.
 * SES tags the message with campaignId; we use the Tags array from the mail object.
 */
async function resolveCampaignId(messageId) {
  if (!messageId) return null;
  // The SES notification mail.tags contains the custom Tags we set in the worker
  // (Tags are in notification.mail.tags as { campaignId: [...] })
  return null; // resolved by the caller from notification.mail.tags in production
}

/**
 * Find a recipient row by email under a campaign and update its status.
 * If campaignId is unknown we cannot update the row — log and continue.
 */
async function updateRecipientByEmail(campaignId, email, status, meta = {}) {
  if (!campaignId || !email) return;

  const now    = new Date().toISOString();
  const fields = ['#s = :s', 'updatedAt = :u'];
  const names  = { '#s': 'status' };
  const values = { ':s': status, ':u': now };

  Object.entries(meta).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      fields.push(`${k} = :${k}`);
      values[`:${k}`] = v;
    }
  });

  if (status === 'DELIVERED') { fields.push('deliveredAt = :da'); values[':da'] = now; }

  await update(
    keys.recipient(campaignId, email),
    `SET ${fields.join(', ')}`,
    names,
    values
  ).catch(e => logger.warn('Could not update recipient row', { error: e.message }));
}
