/**
 * src/handlers/unsubscribe.js
 * One-click unsubscribe endpoint.
 *
 * GET /unsubscribe?token=<base64url-encoded JSON>
 *   — token contains { email, campaignId }
 *   — No auth required (link is sent in email)
 *   — Returns an HTML confirmation page (not JSON)
 *
 * POST /unsubscribe
 *   { email, campaignId?, reason? }
 *   — Authenticated; for operator-initiated suppression
 *
 * Security:
 *   - Token is base64url-encoded; not signed (rely on obscurity for this endpoint).
 *     For higher security, replace with HMAC-signed tokens (see README).
 *   - Rate-limited by API Gateway usage plan (shared with API key).
 *   - Email is suppressed immediately — future sends skip this address.
 */
'use strict';

const { suppress } = require('../lib/suppression');
const { keys, update } = require('../lib/dynamo');
const { badRequest, ok, serverError } = require('../lib/response');
const { withAuth } = require('../lib/auth');
const logger = require('../lib/logger');

// ── GET /unsubscribe?token=... (public, no auth) ───────────────────────────────
exports.handleUnsubscribeLink = async (event) => {
  const token = event.queryStringParameters?.token;
  if (!token) return htmlResponse(400, errorPage('Missing unsubscribe token'));

  let payload;
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    return htmlResponse(400, errorPage('Invalid unsubscribe link'));
  }

  const { email, campaignId } = payload;
  if (!email) return htmlResponse(400, errorPage('Invalid unsubscribe link'));

  try {
    await suppress(email.toLowerCase(), 'unsubscribe', campaignId || null);

    // Update the recipient row for this specific campaign
    if (campaignId) {
      await update(
        keys.recipient(campaignId, email.toLowerCase()),
        'SET #s = :s, unsubscribedAt = :u, updatedAt = :u',
        { '#s': 'status' },
        { ':s': 'UNSUBSCRIBED', ':u': new Date().toISOString() }
      ).catch(() => {}); // Row may not exist if campaign was deleted
    }

    logger.info('Unsubscribe via link successful', { campaignId });
    return htmlResponse(200, successPage());
  } catch (err) {
    logger.error('Unsubscribe failed', { error: err.message });
    return htmlResponse(500, errorPage('An error occurred. Please try again.'));
  }
};

// ── POST /unsubscribe (authenticated, operator use) ────────────────────────────
exports.handleUnsubscribeAPI = withAuth(async (event) => {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return badRequest('Invalid JSON'); }

  const { email, campaignId, reason } = body;
  if (!email || typeof email !== 'string') return badRequest("'email' is required");

  const norm = email.trim().toLowerCase();
  await suppress(norm, reason || 'manual', campaignId || null);
  logger.info('Unsubscribe via API', { campaignId: campaignId || null });
  return ok({ suppressed: norm });
});

// ── HTML helpers ──────────────────────────────────────────────────────────────
function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
}

function successPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0e1a;color:#f1f5f9;}
.card{text-align:center;padding:40px;background:#111827;border-radius:12px;max-width:400px;border:1px solid rgba(255,255,255,.07);}
h1{color:#10b981;margin-bottom:.5rem;}p{color:#8892a4;}</style></head>
<body><div class="card"><h1>✓ Unsubscribed</h1>
<p>You have been successfully removed from our mailing list.</p>
<p>You will not receive any further emails from this sender.</p></div></body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0e1a;color:#f1f5f9;}
.card{text-align:center;padding:40px;background:#111827;border-radius:12px;max-width:400px;border:1px solid rgba(255,255,255,.07);}
h1{color:#ef4444;margin-bottom:.5rem;}p{color:#8892a4;}</style></head>
<body><div class="card"><h1>Error</h1><p>${msg}</p></div></body></html>`;
}
