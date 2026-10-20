/**
 * src/lib/auth.js
 * Request authentication & authorization helpers.
 *
 * The API uses API Gateway with a Lambda authorizer (Cognito JWT verifier pattern).
 * In production, attach a Cognito User Pool authorizer to API Gateway.
 * For local/test, set BYPASS_AUTH=true and MOCK_ACCOUNT_ID.
 *
 * The authorizer injects the verified claims into event.requestContext.authorizer.
 * This module extracts accountId and validates it is present on every secured route.
 */
'use strict';

const { unauthorized, forbidden } = require('./response');
const logger = require('./logger');

/**
 * Extract accountId from API Gateway request context.
 * Supports both Cognito authorizer claims and the mock bypass.
 *
 * @param {object} event — raw Lambda event
 * @returns {{ accountId: string } | null}  null means auth failed
 */
function extractClaims(event) {
  // -- Local dev bypass --------------------------------------------------
  if (process.env.BYPASS_AUTH === 'true') {
    const id = process.env.MOCK_ACCOUNT_ID || 'local-account';
    return { accountId: id, email: `${id}@local.test` };
  }

  // -- Cognito authorizer claims -----------------------------------------
  const claims = event?.requestContext?.authorizer?.claims;
  if (!claims) return null;

  // Cognito sub is the stable user identifier; prefer a custom:accountId claim
  // if operators provision one (allows multi-tenant with shared user pool).
  const accountId = claims['custom:accountId'] || claims.sub;
  const email     = claims.email;

  if (!accountId) return null;
  return { accountId, email };
}

/**
 * Higher-order wrapper: validates auth and injects accountId into the handler.
 * Usage:
 *   exports.handler = withAuth(async (event, context, { accountId }) => { ... })
 */
function withAuth(fn) {
  return async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
      const { preflight } = require('./response');
      return preflight();
    }

    const claims = extractClaims(event);
    if (!claims) {
      logger.warn('Missing or invalid auth token');
      return unauthorized();
    }

    // Inject requestId into logger context for every invocation
    logger.setContext({ requestId: context?.awsRequestId, accountId: claims.accountId });

    try {
      return await fn(event, context, claims);
    } catch (err) {
      logger.error('Unhandled handler error', { error: err.message, stack: err.stack });
      const { serverError } = require('./response');
      return serverError();
    }
  };
}

/**
 * Validate that the caller owns the requested campaign.
 * Returns the campaign item or throws a 403/404 response.
 */
async function assertCampaignOwner(campaignId, accountId) {
  const { get, keys } = require('./dynamo');
  const { Item } = await get(keys.campaign(campaignId));
  if (!Item) {
    return { campaign: null, response: require('./response').notFound('Campaign not found') };
  }
  if (Item.accountId !== accountId) {
    logger.warn('Forbidden campaign access attempt', { campaignId, accountId });
    return { campaign: null, response: forbidden() };
  }
  return { campaign: Item, response: null };
}

module.exports = { extractClaims, withAuth, assertCampaignOwner };
