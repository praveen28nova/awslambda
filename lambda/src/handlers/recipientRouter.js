/**
 * src/handlers/recipientRouter.js
 * Routes /campaigns/{id}/recipients* requests.
 */
'use strict';

const recipients = require('./recipients');

exports.handler = (event, context) => {
  const method = event.httpMethod;
  const path   = event.resource || event.path || '';

  if (path.endsWith('/csv') && method === 'POST') return recipients.addRecipientsCSV(event, context);
  if (method === 'POST')                          return recipients.addRecipients(event, context);
  if (method === 'GET')                           return recipients.listRecipients(event, context);

  const { badRequest } = require('../lib/response');
  return badRequest(`Unhandled route: ${method} ${path}`);
};
