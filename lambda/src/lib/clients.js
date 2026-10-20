/**
 * src/lib/clients.js
 * Shared AWS SDK v3 client singletons.
 * Clients are created once per Lambda cold start and reused across invocations.
 * Region and endpoint configuration are read from environment variables only —
 * no credentials are ever written in source code.
 */
'use strict';

const { DynamoDBClient }  = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { SESClient }        = require('@aws-sdk/client-ses');
const { SQSClient }        = require('@aws-sdk/client-sqs');
const { SNSClient }        = require('@aws-sdk/client-sns');

const REGION = process.env.AWS_REGION || 'us-east-1';

// ── DynamoDB ──────────────────────────────────────────────────────────────────
// LOCAL_ENDPOINT is set only when running `sam local` or Jest with a local DDB.
const dynamoOptions = { region: REGION };
if (process.env.LOCAL_ENDPOINT) {
  dynamoOptions.endpoint = process.env.LOCAL_ENDPOINT;
  dynamoOptions.credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
}
const ddbRaw = new DynamoDBClient(dynamoOptions);
const ddb = DynamoDBDocumentClient.from(ddbRaw, {
  marshallOptions: { removeUndefinedValues: true },
});

// ── SES ───────────────────────────────────────────────────────────────────────
const ses = new SESClient({ region: process.env.SES_REGION || REGION });

// ── SQS ───────────────────────────────────────────────────────────────────────
const sqs = new SQSClient({ region: REGION });

// ── SNS ───────────────────────────────────────────────────────────────────────
const sns = new SNSClient({ region: REGION });

module.exports = { ddb, ses, sqs, sns };
