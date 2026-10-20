/**
 * src/handlers/campaignRouter.js
 * Routes /campaigns/{id}* requests to the correct exported function.
 * A single Lambda handles GET, PATCH /status, DELETE, and GET /preview
 * to keep the function count and cold-start surface small.
 */
'use strict';

const campaigns  = require('./campaigns');
const preview    = require('./preview');

exports.handler = (event, context) => {
  const method = event.httpMethod;
  const path   = event.resource || event.path || '';

  if (path.endsWith('/preview') && method === 'GET')   return preview.preview(event, context);
  if (path.endsWith('/status')  && method === 'PATCH')  return campaigns.updateStatus(event, context);
  if (method === 'DELETE')                               return campaigns.deleteCampaign(event, context);
  if (method === 'GET')                                  return campaigns.get(event, context);

  const { badRequest } = require('../lib/response');
  return badRequest(`Unhandled route: ${method} ${path}`);
};
