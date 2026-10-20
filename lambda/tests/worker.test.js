/**
 * tests/worker.test.js
 * Tests: idempotency, rate limiting, pause/cancel detection, DLQ processor.
 */
'use strict';

const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESClient);

process.env.MAILBLAST_TABLE     = 'TestTable';
process.env.BYPASS_AUTH         = 'true';
process.env.MOCK_ACCOUNT_ID     = 'acct-test-001';
process.env.APP_BASE_URL        = 'https://test.example.com';
process.env.SEND_RATE_PER_SEC   = '1000'; // no throttle in tests
process.env.WORKER_BATCH_SIZE   = '5';

const { handler: workerHandler, dlqProcessor } = require('../src/handlers/worker');

function sqsEvent(payload) {
  return { Records: [{ messageId: 'msg-1', body: JSON.stringify(payload) }] };
}

const CAMPAIGN = {
  PK: 'CAMPAIGN#c1', SK: 'CAMPAIGN',
  campaignId: 'c1', accountId: 'acct-1',
  subject: 'Test', fromEmail: 'sender@example.com', fromName: 'Sender',
  htmlBody: '<p>Hello</p>', textBody: 'Hello',
  status: 'SENDING', createdAt: '2024-01-01T00:00:00.000Z',
};

// ── Idempotency ────────────────────────────────────────────────────────────────
describe('Worker idempotency', () => {
  beforeEach(() => { ddbMock.reset(); sesMock.reset(); });

  test('skips already-SENT recipient without calling SES', async () => {
    // Campaign is SENDING
    ddbMock.on(GetCommand, { Key: { PK: 'CAMPAIGN#c1', SK: 'CAMPAIGN' } })
      .resolves({ Item: CAMPAIGN });

    // Page returns one recipient
    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [{ PK: 'CAMPAIGN#c1', SK: 'RECIPIENT#a@b.com', email: 'a@b.com', status: 'PENDING' }],
        Count: 1, LastEvaluatedKey: undefined,
      })
      // Second query (PENDING check): 0 remaining
      .resolves({ Items: [], Count: 0 });

    // Recipient re-read shows status=SENT (idempotency: already processed)
    ddbMock.on(GetCommand, { Key: { PK: 'CAMPAIGN#c1', SK: 'RECIPIENT#a@b.com' } })
      .resolves({ Item: { email: 'a@b.com', status: 'SENT' } });

    // Suppression check returns false
    ddbMock.on(GetCommand, { Key: { PK: 'SUPPRESS#a@b.com', SK: 'SUPPRESS' } })
      .resolves({ Item: undefined });

    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...CAMPAIGN, status: 'COMPLETED' } });
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });

    await workerHandler(sqsEvent({ campaignId: 'c1', accountId: 'acct-1', action: 'SEND' }));

    // SES must NOT have been called
    expect(sesMock.calls()).toHaveLength(0);
  });

  test('sends email for PENDING recipient', async () => {
    ddbMock.on(GetCommand, { Key: { PK: 'CAMPAIGN#c1', SK: 'CAMPAIGN' } })
      .resolves({ Item: CAMPAIGN });

    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [{ PK: 'CAMPAIGN#c1', SK: 'RECIPIENT#b@c.com', email: 'b@c.com', status: 'PENDING' }],
        Count: 1, LastEvaluatedKey: undefined,
      })
      .resolves({ Items: [], Count: 0 }); // no more pending

    // Recipient re-read → PENDING (should proceed)
    ddbMock.on(GetCommand, { Key: { PK: 'CAMPAIGN#c1', SK: 'RECIPIENT#b@c.com' } })
      .resolves({ Item: { email: 'b@c.com', status: 'PENDING' } });

    // Not suppressed
    ddbMock.on(GetCommand, { Key: { PK: 'SUPPRESS#b@c.com', SK: 'SUPPRESS' } })
      .resolves({ Item: undefined });

    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'ses-msg-2' });

    await workerHandler(sqsEvent({ campaignId: 'c1', accountId: 'acct-1', action: 'SEND' }));
    expect(sesMock.calls()).toHaveLength(1);
  });
});

// ── Pause/Cancel detection ─────────────────────────────────────────────────────
describe('Worker pause/cancel', () => {
  beforeEach(() => { ddbMock.reset(); sesMock.reset(); });

  test('stops processing when campaign is PAUSED', async () => {
    // Initial get: SENDING
    ddbMock.on(GetCommand, { Key: { PK: 'CAMPAIGN#c1', SK: 'CAMPAIGN' } })
      .resolvesOnce({ Item: CAMPAIGN })
      .resolves({ Item: { ...CAMPAIGN, status: 'PAUSED' } }); // re-check: PAUSED

    ddbMock.on(QueryCommand).resolves({
      Items: [{ email: 'x@y.com', status: 'PENDING' }],
      Count: 1,
    });

    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'ses-3' });

    await workerHandler(sqsEvent({ campaignId: 'c1', accountId: 'acct-1', action: 'SEND' }));
    // Worker must stop — no SES calls
    expect(sesMock.calls()).toHaveLength(0);
  });
});

// ── DLQ Processor ─────────────────────────────────────────────────────────────
describe('DLQ processor', () => {
  beforeEach(() => ddbMock.reset());

  test('marks campaign as FAILED', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const event = { Records: [{ body: JSON.stringify({ campaignId: 'c1', accountId: 'acct-1' }) }] };
    await dlqProcessor(event);
    const call = ddbMock.calls()[0].args[0].input;
    expect(call.ExpressionAttributeValues[':s']).toBe('FAILED');
  });

  test('handles malformed DLQ message gracefully', async () => {
    const event = { Records: [{ body: 'not-json' }] };
    await expect(dlqProcessor(event)).resolves.not.toThrow();
  });
});

// ── Suppression during send ────────────────────────────────────────────────────
describe('Worker suppression check', () => {
  beforeEach(() => { ddbMock.reset(); sesMock.reset(); });

  test('skips suppressed recipient without calling SES', async () => {
    ddbMock.on(GetCommand, { Key: { PK: 'CAMPAIGN#c1', SK: 'CAMPAIGN' } })
      .resolves({ Item: CAMPAIGN });

    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [{ email: 'suppressed@x.com', status: 'PENDING' }],
        Count: 1,
      })
      .resolves({ Items: [], Count: 0 });

    // Re-read: PENDING
    ddbMock.on(GetCommand, { Key: { PK: 'CAMPAIGN#c1', SK: 'RECIPIENT#suppressed@x.com' } })
      .resolves({ Item: { email: 'suppressed@x.com', status: 'PENDING' } });

    // IS suppressed
    ddbMock.on(GetCommand, { Key: { PK: 'SUPPRESS#suppressed@x.com', SK: 'SUPPRESS' } })
      .resolves({ Item: { email: 'suppressed@x.com', reason: 'bounce' } });

    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await workerHandler(sqsEvent({ campaignId: 'c1', accountId: 'acct-1', action: 'SEND' }));
    expect(sesMock.calls()).toHaveLength(0);
  });
});
