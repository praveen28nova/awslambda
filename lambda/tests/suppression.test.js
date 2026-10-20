/**
 * tests/suppression.test.js
 * Tests: suppress, bulkCheck, unsuppress, unsubscribe link/API.
 */
'use strict';

const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.MAILBLAST_TABLE = 'TestTable';
process.env.BYPASS_AUTH     = 'true';
process.env.MOCK_ACCOUNT_ID = 'acct-test-001';
process.env.APP_BASE_URL    = 'https://test.example.com';

const { isSuppressed, suppress, unsuppress, bulkCheck } = require('../src/lib/suppression');
const unsubscribe = require('../src/handlers/unsubscribe');

// ── suppress() ────────────────────────────────────────────────────────────────
describe('suppress()', () => {
  beforeEach(() => ddbMock.reset());

  test('writes a suppression record', async () => {
    ddbMock.on(PutCommand).resolves({});
    await expect(suppress('User@Example.COM', 'bounce', 'camp-1')).resolves.not.toThrow();
    const putCall = ddbMock.calls()[0].args[0].input;
    expect(putCall.Item.email).toBe('user@example.com');  // normalised
    expect(putCall.Item.reason).toBe('bounce');
  });
});

// ── isSuppressed() ─────────────────────────────────────────────────────────────
describe('isSuppressed()', () => {
  beforeEach(() => ddbMock.reset());

  test('returns true when item exists', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'bad@example.com' } });
    expect(await isSuppressed('bad@example.com')).toBe(true);
  });

  test('returns false when item does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    expect(await isSuppressed('good@example.com')).toBe(false);
  });

  test('normalises email to lowercase before lookup', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'bad@example.com' } });
    expect(await isSuppressed('BAD@EXAMPLE.COM')).toBe(true);
    const key = ddbMock.calls()[0].args[0].input.Key;
    expect(key.PK).toBe('SUPPRESS#bad@example.com');
  });
});

// ── bulkCheck() ────────────────────────────────────────────────────────────────
describe('bulkCheck()', () => {
  beforeEach(() => ddbMock.reset());

  test('returns a Set of suppressed emails', async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: 'SUPPRESS#a@b.com', SK: 'SUPPRESS' } })
      .resolves({ Item: { email: 'a@b.com' } })
      .on(GetCommand, { Key: { PK: 'SUPPRESS#c@d.com', SK: 'SUPPRESS' } })
      .resolves({ Item: undefined });

    const result = await bulkCheck(['a@b.com', 'c@d.com']);
    expect(result.has('a@b.com')).toBe(true);
    expect(result.has('c@d.com')).toBe(false);
  });
});

// ── unsuppress() ──────────────────────────────────────────────────────────────
describe('unsuppress()', () => {
  beforeEach(() => ddbMock.reset());

  test('deletes the suppression record', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await unsuppress('user@example.com');
    const call = ddbMock.calls()[0].args[0].input;
    expect(call.Key.PK).toBe('SUPPRESS#user@example.com');
  });
});

// ── Unsubscribe link (GET) ─────────────────────────────────────────────────────
describe('GET /unsubscribe (link)', () => {
  beforeEach(() => ddbMock.reset());

  function makeToken(email, campaignId) {
    return Buffer.from(JSON.stringify({ email, campaignId })).toString('base64url');
  }

  test('suppresses the address and returns HTML 200', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const token = makeToken('user@example.com', 'camp-1');
    const event = { httpMethod: 'GET', queryStringParameters: { token } };
    const res   = await unsubscribe.handleUnsubscribeLink(event);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.body).toContain('Unsubscribed');

    // Verify suppression was written
    const putCall = ddbMock.calls().find(c => c.args[0].input?.Item?.reason === 'unsubscribe');
    expect(putCall).toBeDefined();
    expect(putCall.args[0].input.Item.email).toBe('user@example.com');
  });

  test('returns 400 HTML for missing token', async () => {
    const event = { httpMethod: 'GET', queryStringParameters: {} };
    const res   = await unsubscribe.handleUnsubscribeLink(event);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Error');
  });

  test('returns 400 HTML for malformed token', async () => {
    const event = { httpMethod: 'GET', queryStringParameters: { token: 'not-valid-base64url' } };
    const res   = await unsubscribe.handleUnsubscribeLink(event);
    expect(res.statusCode).toBe(400);
  });
});
