/**
 * tests/campaigns.test.js
 * Tests: campaign lifecycle, ownership, status-machine transitions.
 */
'use strict';

const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

// Mock AWS clients BEFORE requiring any app code
const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

// Stub environment variables
process.env.MAILBLAST_TABLE    = 'TestTable';
process.env.CAMPAIGN_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/test.fifo';
process.env.BYPASS_AUTH        = 'true';
process.env.MOCK_ACCOUNT_ID    = 'acct-test-001';
process.env.APP_BASE_URL       = 'https://test.example.com';

const campaigns = require('../src/handlers/campaigns');

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeEvent(method, body = {}, pathParams = {}) {
  return {
    httpMethod: method,
    pathParameters: pathParams,
    queryStringParameters: null,
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'acct-test-001', email: 'test@example.com' } } },
  };
}

const CTX = { awsRequestId: 'req-test-001' };

// ── Campaign CREATE ────────────────────────────────────────────────────────────
describe('POST /campaigns — create', () => {
  beforeEach(() => { ddbMock.reset(); sqsMock.reset(); });

  test('returns 201 with safe campaign object (no body in response)', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('POST', {
      subject:   'Hello subscribers',
      fromEmail: 'sender@example.com',
      fromName:  'Sender Name',
      htmlBody:  '<p>Hello!</p>',
    });

    const res = JSON.parse((await campaigns.create(event, CTX)).body);
    expect(res.campaign).toBeDefined();
    expect(res.campaign.campaignId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.campaign.status).toBe('DRAFT');
    // body MUST NOT be returned
    expect(res.campaign.htmlBody).toBeUndefined();
    expect(res.campaign.textBody).toBeUndefined();
  });

  test('returns 400 when required fields are missing', async () => {
    const event = makeEvent('POST', { subject: 'No from email' });
    const res = await campaigns.create(event, CTX);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/fromEmail/);
  });

  test('returns 400 for invalid fromEmail', async () => {
    const event = makeEvent('POST', {
      subject: 'Test', fromEmail: 'not-an-email', fromName: 'X', htmlBody: '<p>y</p>',
    });
    const res = await campaigns.create(event, CTX);
    expect(res.statusCode).toBe(400);
  });

  test('sets status=SCHEDULED when scheduledAt is provided', async () => {
    ddbMock.on(PutCommand).resolves({});
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const event = makeEvent('POST', {
      subject: 'Scheduled', fromEmail: 'a@b.com', fromName: 'A', htmlBody: '<p>hi</p>', scheduledAt,
    });
    const res = JSON.parse((await campaigns.create(event, CTX)).body);
    expect(res.campaign.status).toBe('SCHEDULED');
  });

  test('returns 400 for invalid scheduledAt', async () => {
    const event = makeEvent('POST', {
      subject: 'X', fromEmail: 'a@b.com', fromName: 'A', htmlBody: '<p>y</p>', scheduledAt: 'not-a-date',
    });
    expect((await campaigns.create(event, CTX)).statusCode).toBe(400);
  });
});

// ── Campaign GET ───────────────────────────────────────────────────────────────
describe('GET /campaigns/{id}', () => {
  beforeEach(() => ddbMock.reset());

  test('returns 200 with campaign (body fields stripped)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        PK: 'CAMPAIGN#abc', SK: 'CAMPAIGN',
        campaignId: 'abc', accountId: 'acct-test-001',
        subject: 'Test', fromEmail: 'a@b.com', status: 'DRAFT',
        htmlBody: '<p>secret</p>', textBody: 'secret',
      },
    });
    const event = makeEvent('GET', {}, { id: 'abc' });
    const res = JSON.parse((await campaigns.get(event, CTX)).body);
    expect(res.campaign.subject).toBe('Test');
    expect(res.campaign.htmlBody).toBeUndefined();
    expect(res.campaign.textBody).toBeUndefined();
  });

  test('returns 404 when campaign does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const event = makeEvent('GET', {}, { id: 'nonexistent' });
    expect((await campaigns.get(event, CTX)).statusCode).toBe(404);
  });

  test('returns 403 when campaign belongs to different account', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { campaignId: 'abc', accountId: 'different-account', status: 'DRAFT' },
    });
    const event = makeEvent('GET', {}, { id: 'abc' });
    expect((await campaigns.get(event, CTX)).statusCode).toBe(403);
  });
});

// ── Status machine ─────────────────────────────────────────────────────────────
describe('PATCH /campaigns/{id}/status — transitions', () => {
  beforeEach(() => { ddbMock.reset(); sqsMock.reset(); });

  const baseCampaign = {
    campaignId: 'c1', accountId: 'acct-test-001',
    status: 'DRAFT', createdAt: '2024-01-01T00:00:00.000Z',
    htmlBody: '<p>x</p>',
  };

  function mockGet(item) {
    ddbMock.on(GetCommand).resolves({ Item: item });
  }

  test('DRAFT → SCHEDULED is allowed', async () => {
    mockGet({ ...baseCampaign, status: 'DRAFT' });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...baseCampaign, status: 'SCHEDULED', htmlBody: '<p>x</p>' } });
    const event = makeEvent('PATCH', { status: 'SCHEDULED' }, { id: 'c1' });
    const res = await campaigns.updateStatus(event, CTX);
    expect(res.statusCode).toBe(200);
  });

  test('DRAFT → SENDING is NOT allowed', async () => {
    mockGet({ ...baseCampaign, status: 'DRAFT' });
    const event = makeEvent('PATCH', { status: 'SENDING' }, { id: 'c1' });
    expect((await campaigns.updateStatus(event, CTX)).statusCode).toBe(409);
  });

  test('COMPLETED → CANCELLED is NOT allowed', async () => {
    mockGet({ ...baseCampaign, status: 'COMPLETED' });
    const event = makeEvent('PATCH', { status: 'CANCELLED' }, { id: 'c1' });
    expect((await campaigns.updateStatus(event, CTX)).statusCode).toBe(409);
  });

  test('SCHEDULED → SENDING enqueues to SQS', async () => {
    mockGet({ ...baseCampaign, status: 'SCHEDULED' });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'msg-1' });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...baseCampaign, status: 'SENDING' } });
    const event = makeEvent('PATCH', { status: 'SENDING' }, { id: 'c1' });
    const res = await campaigns.updateStatus(event, CTX);
    expect(res.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(1);
  });
});

// ── Campaign DELETE ────────────────────────────────────────────────────────────
describe('DELETE /campaigns/{id}', () => {
  beforeEach(() => ddbMock.reset());

  test('deletes DRAFT campaign', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { campaignId: 'd1', accountId: 'acct-test-001', status: 'DRAFT' },
    });
    ddbMock.on(require('@aws-sdk/lib-dynamodb').DeleteCommand).resolves({});
    const event = makeEvent('DELETE', {}, { id: 'd1' });
    expect((await campaigns.deleteCampaign(event, CTX)).statusCode).toBe(204);
  });

  test('cannot delete SENDING campaign', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { campaignId: 'd2', accountId: 'acct-test-001', status: 'SENDING' },
    });
    const event = makeEvent('DELETE', {}, { id: 'd2' });
    expect((await campaigns.deleteCampaign(event, CTX)).statusCode).toBe(409);
  });
});
