/**
 * src/lib/response.js
 * Standard API Gateway HTTP response helpers.
 * CORS headers are always included so the existing frontend works out of the box.
 */
'use strict';

const CORS = {
  'Access-Control-Allow-Origin':  process.env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
};

/**
 * Build a JSON API Gateway response.
 * @param {number} statusCode
 * @param {object} body
 */
function res(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

const ok      = (body)    => res(200, body);
const created = (body)    => res(201, body);
const noContent = ()      => ({ statusCode: 204, headers: CORS, body: '' });
const badRequest = (msg, details) => res(400, { error: 'BAD_REQUEST',   message: msg, ...(details ? { details } : {}) });
const unauthorized   = (msg = 'Unauthorized')   => res(401, { error: 'UNAUTHORIZED',   message: msg });
const forbidden      = (msg = 'Forbidden')       => res(403, { error: 'FORBIDDEN',      message: msg });
const notFound       = (msg = 'Not found')       => res(404, { error: 'NOT_FOUND',      message: msg });
const conflict       = (msg)                     => res(409, { error: 'CONFLICT',       message: msg });
const tooManyReqs    = (msg = 'Rate limit exceeded') => res(429, { error: 'TOO_MANY_REQUESTS', message: msg });
const serverError    = (msg = 'Internal error')  => res(500, { error: 'INTERNAL_ERROR', message: msg });
const preflight      = ()  => ({ statusCode: 200, headers: CORS, body: '' });

module.exports = { ok, created, noContent, badRequest, unauthorized, forbidden, notFound, conflict, tooManyReqs, serverError, preflight, res };
