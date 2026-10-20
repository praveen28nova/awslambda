/**
 * local-server.js
 * Local development API server — mocks all MailBlast Lambda endpoints.
 * Stores all data in-memory so the full app UI works without AWS.
 *
 * Run: node local-server.js
 * API: http://localhost:3001
 */
'use strict';

const http  = require('http');
const { v4: uuidv4 } = require('uuid');
let sesClient = null;
try {
  const { SESClient } = require('@aws-sdk/client-ses');
  sesClient = new SESClient({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
} catch (e) {
  console.log('[Notice] SES client init error:', e.message);
}

const PORT = 3001;

// ── In-memory store ───────────────────────────────────────────────────────────
const db = {
  campaigns:   {},   // campaignId → campaign
  recipients:  {},   // campaignId → { email → recipient }
  suppressed:  new Set(),
  history:     [],
};

const ACCOUNT_ID = 'local-account-001';

// ── CORS helpers ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
}

function json(res, code, body) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function htmlOk(res, html) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Status machine ─────────────────────────────────────────────────────────────
const TRANSITIONS = {
  DRAFT:     ['SCHEDULED', 'SENDING', 'CANCELLED'],
  SCHEDULED: ['SENDING', 'CANCELLED'],
  SENDING:   ['PAUSED', 'CANCELLED', 'COMPLETED'],
  PAUSED:    ['SENDING', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

// ── Real / Simulated sending (non-blocking) ───────────────────────────────────
function simulateSend(campaignId) {
  const campaign = db.campaigns[campaignId];
  if (!campaign) return;

  const recs = Object.values(db.recipients[campaignId] || {});
  const pending = recs.filter(r => r.status === 'PENDING');
  if (pending.length === 0) {
    campaign.status = 'COMPLETED';
    campaign.completedAt = new Date().toISOString();
    logHistory(campaign, 0, 0);
    return;
  }

  let sent = 0, failed = 0;
  let i = 0;
  let lastError = null;

  async function sendNext() {
    if (campaign.status === 'PAUSED' || campaign.status === 'CANCELLED') return;
    if (i >= pending.length) {
      campaign.status = failed === pending.length && pending.length > 0 ? 'FAILED' : 'COMPLETED';
      campaign.completedAt = new Date().toISOString();
      campaign.sentCount = sent;
      campaign.deliveredCount = sent;
      campaign.failedCount = failed;
      campaign.lastError = lastError;
      logHistory(campaign, sent, failed);
      console.log(`[✓] Campaign "${campaign.subject}" completed — sent:${sent} failed:${failed}`);
      return;
    }
    const rec = pending[i++];
    if (db.suppressed.has(rec.email)) {
      rec.status = 'SUPPRESSED';
      rec.updatedAt = new Date().toISOString();
      setTimeout(sendNext, 40);
      return;
    }

    if (sesClient) {
      try {
        const { SendEmailCommand } = require('@aws-sdk/client-ses');
        const fromAddr = campaign.fromName ? `"${campaign.fromName}" <${campaign.fromEmail}>` : campaign.fromEmail;
        const res = await sesClient.send(new SendEmailCommand({
          Source: fromAddr,
          Destination: { ToAddresses: [rec.email] },
          Message: {
            Subject: { Data: campaign.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: campaign.htmlBody, Charset: 'UTF-8' },
              ...(campaign.textBody ? { Text: { Data: campaign.textBody, Charset: 'UTF-8' } } : {}),
            },
          },
          ...(campaign.replyTo ? { ReplyToAddresses: [campaign.replyTo] } : {}),
        }));
        rec.status = 'DELIVERED';
        rec.messageId = res.MessageId;
        rec.deliveredAt = new Date().toISOString();
        sent++;
        console.log(`[✓ SES] Email delivered to ${rec.email} (MessageId: ${res.MessageId})`);
      } catch (err) {
        rec.status = 'FAILED';
        rec.error = err.message || err.name;
        lastError = err.message || err.name;
        failed++;
        console.error(`[✗ SES ERROR] Failed sending to ${rec.email}: ${err.name} - ${err.message}`);
      }
    } else {
      rec.status = 'DELIVERED';
      rec.deliveredAt = new Date().toISOString();
      sent++;
    }
    setTimeout(sendNext, 120);
  }

  setTimeout(sendNext, 200);
}

function logHistory(campaign, sent, failed) {
  db.history.unshift({
    campaignId:    campaign.campaignId,
    name:          campaign.name || campaign.subject,
    subject:       campaign.subject,
    sent,
    delivered:     sent,
    failed,
    total:         sent + failed,
    date:          new Date().toISOString(),
    status:        failed === 0 ? 'success' : sent > 0 ? 'partial' : 'failed',
  });
}

// ── Router ─────────────────────────────────────────────────────────────────────
async function route(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  console.log(`${method} ${path}`);

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (method === 'OPTIONS') { cors(res); res.writeHead(200); res.end(); return; }

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/health') {
    return json(res, 200, { status: 'ok', mode: 'local-mock', accountId: ACCOUNT_ID });
  }

  // ── POST /campaigns ─────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/campaigns') {
    const body = await readBody(req);
    const { subject, fromEmail, fromName, replyTo, htmlBody, textBody, scheduledAt, name } = body;
    if (!subject || !fromEmail || !fromName || !htmlBody) {
      return json(res, 400, { error: 'BAD_REQUEST', message: 'Missing required fields: subject, fromEmail, fromName, htmlBody' });
    }
    const campaignId = uuidv4();
    const now = new Date().toISOString();
    const campaign = {
      campaignId, accountId: ACCOUNT_ID,
      name: name || subject,
      subject, fromEmail, fromName,
      replyTo: replyTo || null, htmlBody, textBody: textBody || null,
      scheduledAt: scheduledAt || null,
      status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
      recipientCount: 0, sentCount: 0, deliveredCount: 0,
      bouncedCount: 0, complainedCount: 0, failedCount: 0,
      createdAt: now, updatedAt: now,
    };
    db.campaigns[campaignId] = campaign;
    db.recipients[campaignId] = {};
    const { htmlBody: _h, textBody: _t, ...safe } = campaign;
    return json(res, 201, { campaign: safe });
  }

  // ── GET /campaigns ──────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/campaigns') {
    const list = Object.values(db.campaigns)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ htmlBody, textBody, ...safe }) => safe);
    return json(res, 200, { campaigns: list, count: list.length });
  }

  // ── GET /campaigns/:id ──────────────────────────────────────────────────────
  const campaignMatch = path.match(/^\/campaigns\/([^/]+)$/);
  if (campaignMatch) {
    const id = campaignMatch[1];
    if (method === 'GET') {
      const c = db.campaigns[id];
      if (!c) return json(res, 404, { error: 'NOT_FOUND', message: 'Campaign not found' });
      const { htmlBody, textBody, ...safe } = c;
      return json(res, 200, { campaign: safe });
    }
    if (method === 'DELETE') {
      const c = db.campaigns[id];
      if (!c) return json(res, 404, { error: 'NOT_FOUND' });
      if (!['DRAFT', 'CANCELLED'].includes(c.status))
        return json(res, 409, { error: 'CONFLICT', message: `Cannot delete ${c.status} campaign` });
      delete db.campaigns[id];
      delete db.recipients[id];
      res.writeHead(204); res.end();
      return;
    }
  }

  // ── GET /campaigns/:id/preview ───────────────────────────────────────────────
  const previewMatch = path.match(/^\/campaigns\/([^/]+)\/preview$/);
  if (previewMatch && method === 'GET') {
    const c = db.campaigns[previewMatch[1]];
    if (!c) return json(res, 404, { error: 'NOT_FOUND' });
    return json(res, 200, {
      subject: c.subject, fromName: c.fromName, fromEmail: c.fromEmail,
      htmlBody: (c.htmlBody || '') + `<br><hr><p style="font-size:12px;color:#999;"><a href="#">Unsubscribe</a> | Preview mode</p>`,
      textBody: c.textBody, status: c.status,
    });
  }

  // ── PATCH /campaigns/:id/status ──────────────────────────────────────────────
  const statusMatch = path.match(/^\/campaigns\/([^/]+)\/status$/);
  if (statusMatch && method === 'PATCH') {
    const id = statusMatch[1];
    const body = await readBody(req);
    const c = db.campaigns[id];
    if (!c) return json(res, 404, { error: 'NOT_FOUND' });
    const { status } = body;
    const allowed = TRANSITIONS[c.status] || [];
    if (!allowed.includes(status))
      return json(res, 409, { error: 'CONFLICT', message: `Cannot transition from ${c.status} to ${status}` });
    c.status = status;
    c.updatedAt = new Date().toISOString();
    if (status === 'SENDING') {
      console.log(`[→] Starting send simulation for campaign: ${c.subject}`);
      simulateSend(id);
    }
    const { htmlBody, textBody, ...safe } = c;
    return json(res, 200, { campaign: safe });
  }

  // ── POST /campaigns/:id/recipients ───────────────────────────────────────────
  const recipMatch = path.match(/^\/campaigns\/([^/]+)\/recipients$/);
  if (recipMatch && method === 'POST') {
    const id = recipMatch[1];
    const body = await readBody(req);
    const c = db.campaigns[id];
    if (!c) return json(res, 404, { error: 'NOT_FOUND' });
    if (!['DRAFT', 'SCHEDULED'].includes(c.status))
      return json(res, 409, { error: 'CONFLICT', message: `Cannot add recipients to ${c.status} campaign` });

    const raw = body.recipients || [];
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let added = 0, skippedInvalid = 0, skippedSuppressed = 0;
    const now = new Date().toISOString();

    const seen = new Set(Object.keys(db.recipients[id] || {}));
    for (const item of raw) {
      const emailStr = typeof item === 'string' ? item : (item && item.email ? item.email : '');
      const e = (emailStr || '').trim().toLowerCase();
      if (!emailRe.test(e)) { skippedInvalid++; continue; }
      if (seen.has(e)) continue;
      if (db.suppressed.has(e)) { skippedSuppressed++; continue; }
      seen.add(e);
      db.recipients[id][e] = { email: e, status: 'PENDING', addedAt: now, updatedAt: now };
      added++;
    }
    c.recipientCount = Object.keys(db.recipients[id]).length;
    c.updatedAt = now;
    return json(res, 201, { added, skippedInvalid, skippedSuppressed, total: c.recipientCount });
  }

  // ── GET /campaigns/:id/recipients ────────────────────────────────────────────
  if (recipMatch && method === 'GET') {
    const id = recipMatch[1];
    if (!db.campaigns[id]) return json(res, 404, { error: 'NOT_FOUND' });
    const list = Object.values(db.recipients[id] || {});
    return json(res, 200, { recipients: list, count: list.length });
  }

  // ── GET /campaigns/:id/stats (live progress polling) ────────────────────────
  const statsMatch = path.match(/^\/campaigns\/([^/]+)\/stats$/);
  if (statsMatch && method === 'GET') {
    const c = db.campaigns[statsMatch[1]];
    if (!c) return json(res, 404, { error: 'NOT_FOUND' });
    const recs = Object.values(db.recipients[statsMatch[1]] || {});
    const failedList = recs.filter(r => r.status === 'FAILED');
    return json(res, 200, {
      status: c.status,
      recipientCount: c.recipientCount,
      pending:   recs.filter(r => r.status === 'PENDING').length,
      sent:      recs.filter(r => r.status === 'DELIVERED').length,
      failed:    failedList.length,
      suppressed: recs.filter(r => r.status === 'SUPPRESSED').length,
      lastError: c.lastError || (failedList.length > 0 ? failedList[0].error : null),
    });
  }

  // ── POST /unsubscribe ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/unsubscribe') {
    const body = await readBody(req);
    const email = (body.email || '').trim().toLowerCase();
    if (!email) return json(res, 400, { error: 'BAD_REQUEST', message: 'email is required' });
    db.suppressed.add(email);
    console.log(`[✗] Unsubscribed: ${email}`);
    return json(res, 200, { suppressed: email });
  }

  // ── GET /unsubscribe?token=... ───────────────────────────────────────────────
  if (method === 'GET' && path === '/unsubscribe') {
    const token = url.searchParams.get('token');
    if (token) {
      try {
        const { email } = JSON.parse(Buffer.from(token, 'base64url').toString());
        if (email) db.suppressed.add(email.toLowerCase());
      } catch { /* ignore bad tokens */ }
    }
    return htmlOk(res, `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Unsubscribed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0e1a;color:#f1f5f9;}
.card{text-align:center;padding:40px;background:#111827;border-radius:12px;max-width:400px;border:1px solid rgba(255,255,255,.07);}
h1{color:#10b981;}</style></head>
<body><div class="card"><h1>✓ Unsubscribed</h1><p style="color:#8892a4;">You won't receive any further emails.</p></div></body></html>`);
  }

  // ── GET /history ──────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/history') {
    return json(res, 200, { history: db.history });
  }

  // ── GET /stats (dashboard totals) ────────────────────────────────────────────
  if (method === 'GET' && path === '/stats') {
    const campaigns = Object.values(db.campaigns);
    return json(res, 200, {
      totalCampaigns: campaigns.length,
      totalSent:      campaigns.reduce((s, c) => s + (c.sentCount || 0), 0),
      totalDelivered: campaigns.reduce((s, c) => s + (c.deliveredCount || 0), 0),
      totalContacts:  [...new Set(Object.values(db.recipients).flatMap(r => Object.keys(r)))].length,
    });
  }

  // 404
  return json(res, 404, { error: 'NOT_FOUND', message: `No route: ${method} ${path}` });
}

// ── Start server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error('Server error:', err.message);
    json(res, 500, { error: 'INTERNAL_ERROR', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║         MailBlast Local API Server                   ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  API:      http://localhost:${PORT}                      ║`);
  console.log('║  Mode:     In-memory mock (no AWS required)          ║');
  console.log('║  Auth:     Bypassed (BYPASS_AUTH=true)               ║');
  console.log('║                                                      ║');
  console.log('║  Open:  frontend/index.html  in your browser        ║');
  console.log('║  Then:  Settings → paste  http://localhost:3001      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE')
    console.error(`Port ${PORT} is already in use. Kill the existing process first.`);
  else
    console.error('Server error:', err);
  process.exit(1);
});
