/**
 * lambda/index.js
 *
 * ⚠️  DEPRECATED — superseded by the v2 multi-handler architecture in src/
 *
 * This file was the original single-handler proof-of-concept (v1).
 * It has been replaced by:
 *
 *   src/handlers/campaigns.js    — Campaign CRUD + status machine
 *   src/handlers/worker.js       — SQS batch send worker
 *   src/handlers/recipients.js   — Recipient management + CSV import
 *   src/handlers/events.js       — SES bounce/complaint/delivery processor
 *   src/handlers/unsubscribe.js  — One-click unsubscribe
 *   src/handlers/preview.js      — Campaign body preview
 *
 * See template.yaml and README.md for the full architecture.
 * Do NOT deploy this file — it is kept for reference only.
 */
'use strict';

throw new Error(
  'lambda/index.js is deprecated. Deploy src/ handlers via template.yaml.'
);
