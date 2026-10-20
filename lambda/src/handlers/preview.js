/**
 * src/handlers/preview.js
 * Campaign preview endpoint — returns rendered HTML/text with substitutions.
 * Never sends email. Requires campaign ownership.
 *
 * GET /campaigns/{id}/preview
 */
'use strict';

const { withAuth, assertCampaignOwner } = require('../lib/auth');
const { get, keys } = require('../lib/dynamo');
const { ok, badRequest } = require('../lib/response');

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://example.com';

exports.preview = withAuth(async (event, _ctx, { accountId }) => {
  const campaignId = event.pathParameters?.id;
  if (!campaignId) return badRequest('Missing campaign id');

  const { campaign, response } = await assertCampaignOwner(campaignId, accountId);
  if (response) return response;

  const unsubUrl   = `${APP_BASE_URL}/unsubscribe?token=PREVIEW_TOKEN`;
  const unsubHtml  = `<br><hr><p style="font-size:12px;color:#999;">
    <a href="${unsubUrl}">Unsubscribe</a> | Preview mode — not a real link</p>`;

  return ok({
    subject:  campaign.subject,
    fromName: campaign.fromName,
    fromEmail: campaign.fromEmail,
    htmlBody: (campaign.htmlBody || '') + unsubHtml,
    textBody: campaign.textBody
      ? campaign.textBody + `\n\n---\nUnsubscribe: ${unsubUrl}`
      : null,
    status:   campaign.status,
  });
});
