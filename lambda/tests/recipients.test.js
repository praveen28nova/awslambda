/**
 * tests/recipients.test.js
 * Tests: email validation, deduplication, suppression filtering, cap enforcement, CSV.
 */
'use strict';

const { mockClient } = require('aws-sdk-client-mock');
const {
  DynamoDBDocumentClient, GetCommand, UpdateCommand, BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.MAILBLAST_TABLE = 'TestTable';
process.env.BYPASS_AUTH     = 'true';
process.env.MOCK_ACCOUNT_ID = 'acct-test-001';

const recipients = require('../src/handlers/recipients');

function makeEvent(method, body, pathParams = {}) {
  return {
    httpMethod: method,
    pathParameters: pathParams,
    queryStringParameters: {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { claims: { sub: 'acct-test-001' } } },
  };
}

const CTX = { awsRequestId: 'req-r-001' };

const DRAFT_CAMPAIGN = {
  PK: 'CAMPAIGN#c1', SK: 'CAMPAIGN',
  campaignId: 'c1', accountId: 'acct-test-001',
  status: 'DRAFT', recipientCount: 0,
};

// ── Add recipients (JSON) ─────────────────────────────────────────────────────
describe('POST /campaigns/{id}/recipients', () => {
  beforeEach(() => ddbMock.reset());

  test('adds valid recipients and returns 201', async () => {
    // First GetCommand → campaign ownership check
    // Subsequent GetCommands → suppression checks (return undefined = not suppressed)
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: DRAFT_CAMPAIGN })   // campaign ownership
      .resolves({ Item: undefined });            // all suppression checks

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    const event = makeEvent('POST', {
      recipients: ['alice@example.com', 'bob@example.com'],
    }, { id: 'c1' });

    const res = JSON.parse((await recipients.addRecipients(event, CTX)).body);
    expect(res.added).toBe(2);
    expect(res.skippedInvalid).toBe(0);
    expect(res.skippedSuppressed).toBe(0);
  });

  test('deduplicates email addresses', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: DRAFT_CAMPAIGN })
      .resolves({ Item: undefined });

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    const event = makeEvent('POST', {
      recipients: ['dup@example.com', 'DUP@example.com', 'DUP@EXAMPLE.COM'],
    }, { id: 'c1' });

    const res = JSON.parse((await recipients.addRecipients(event, CTX)).body);
    expect(res.added).toBe(1); // deduplicated to one
  });

  test('filters invalid email addresses', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: DRAFT_CAMPAIGN })
      .resolves({ Item: undefined });

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    const event = makeEvent('POST', {
      recipients: ['good@example.com', 'not-an-email', '@missinglocal.com', ''],
    }, { id: 'c1' });

    const res = JSON.parse((await recipients.addRecipients(event, CTX)).body);
    expect(res.added).toBe(1);
    expect(res.skippedInvalid).toBe(3);
  });

  test('filters suppressed addresses', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: DRAFT_CAMPAIGN })               // campaign check
      .resolvesOnce({ Item: { email: 'suppressed@x.com' } }) // suppressed@x.com IS suppressed
      .resolvesOnce({ Item: undefined });                    // clean@x.com is NOT

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    const event = makeEvent('POST', {
      recipients: ['suppressed@x.com', 'clean@x.com'],
    }, { id: 'c1' });

    const res = JSON.parse((await recipients.addRecipients(event, CTX)).body);
    expect(res.added).toBe(1);
    expect(res.skippedSuppressed).toBe(1);
  });

  test('rejects if campaign is SENDING (not DRAFT/SCHEDULED)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DRAFT_CAMPAIGN, status: 'SENDING' },
    });

    const event = makeEvent('POST', { recipients: ['a@b.com'] }, { id: 'c1' });
    expect((await recipients.addRecipients(event, CTX)).statusCode).toBe(409);
  });

  test('enforces per-campaign 100k recipient cap', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DRAFT_CAMPAIGN, recipientCount: 99_999 },
    });

    const event = makeEvent('POST', {
      recipients: ['a@b.com', 'c@d.com'], // 2 would push to 100_001
    }, { id: 'c1' });

    const res = await recipients.addRecipients(event, CTX);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toMatch(/limit/i);
  });

  test('returns 404 when campaign does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const event = makeEvent('POST', { recipients: ['a@b.com'] }, { id: 'missing' });
    expect((await recipients.addRecipients(event, CTX)).statusCode).toBe(404);
  });

  test('returns 400 when ALL emails are invalid', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: DRAFT_CAMPAIGN })
      .resolves({ Item: undefined });

    const event = makeEvent('POST', { recipients: ['bad', 'alsobad'] }, { id: 'c1' });
    expect((await recipients.addRecipients(event, CTX)).statusCode).toBe(400);
  });
});

// ── CSV import ─────────────────────────────────────────────────────────────────
describe('POST /campaigns/{id}/recipients/csv', () => {
  beforeEach(() => ddbMock.reset());

  test('parses CSV and adds valid recipients', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: DRAFT_CAMPAIGN })
      .resolves({ Item: undefined }); // no suppressions

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    const csv = 'name,email\nAlice,alice@csv.com\nBob,bob@csv.com\nBad,not-an-email\n';
    const event = makeEvent('POST', csv, { id: 'c1' });

    const res = JSON.parse((await recipients.addRecipientsCSV(event, CTX)).body);
    expect(res.added).toBe(2);
    expect(res.skippedInvalid).toBe(1);
  });

  test('returns 400 for CSV without email column', async () => {
    ddbMock.on(GetCommand).resolves({ Item: DRAFT_CAMPAIGN });
    const csv = 'name,phone\nAlice,555-1234\n';
    const event = makeEvent('POST', csv, { id: 'c1' });
    expect((await recipients.addRecipientsCSV(event, CTX)).statusCode).toBe(400);
  });
});
