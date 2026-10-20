/**
 * src/handlers/unsubscribeRouter.js
 * Routes public GET and authenticated POST /unsubscribe.
 */
'use strict';

const { handleUnsubscribeLink, handleUnsubscribeAPI } = require('./unsubscribe');
const { preflight } = require('../lib/response');

exports.handler = (event, context) => {
  if (event.httpMethod === 'OPTIONS') return Promise.resolve(preflight());
  if (event.httpMethod === 'GET')     return handleUnsubscribeLink(event, context);
  if (event.httpMethod === 'POST')    return handleUnsubscribeAPI(event, context);

  const { badRequest } = require('../lib/response');
  return Promise.resolve(badRequest('Method not allowed'));
};
