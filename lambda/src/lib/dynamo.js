/**
 * src/lib/dynamo.js
 * DynamoDB table name constants and low-level helpers.
 *
 * Table layout (single-table design):
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ Table: MAILBLAST_TABLE                                                      │
 * │                                                                             │
 * │ PK                        SK                   Entity                       │
 * │ ─────────────────────     ──────────────────    ──────────────────────────  │
 * │ ACCOUNT#{accountId}       ACCOUNT               Account metadata            │
 * │ CAMPAIGN#{campaignId}     CAMPAIGN              Campaign record             │
 * │ CAMPAIGN#{campaignId}     RECIPIENT#{email}     Per-recipient delivery row  │
 * │ SUPPRESS#{email}          SUPPRESS              Global suppression list      │
 * │                                                                             │
 * │ GSI1: GSI1PK / GSI1SK — used to list campaigns by account                  │
 * │   GSI1PK = ACCOUNT#{accountId}                                              │
 * │   GSI1SK = STATUS#{status}#CREATED#{createdAt}                              │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
'use strict';

const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, BatchWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('./clients');

const TABLE = process.env.MAILBLAST_TABLE || 'MailBlast';

// ── Key builders ──────────────────────────────────────────────────────────────
const keys = {
  account:   (id)     => ({ PK: `ACCOUNT#${id}`,   SK: 'ACCOUNT' }),
  campaign:  (id)     => ({ PK: `CAMPAIGN#${id}`,  SK: 'CAMPAIGN' }),
  recipient: (cId, e) => ({ PK: `CAMPAIGN#${cId}`, SK: `RECIPIENT#${e}` }),
  suppress:  (e)      => ({ PK: `SUPPRESS#${e}`,   SK: 'SUPPRESS' }),
};

// ── Generic wrappers ──────────────────────────────────────────────────────────
const get    = (key, projection) => ddb.send(new GetCommand({
  TableName: TABLE, Key: key,
  ...(projection ? { ProjectionExpression: projection } : {}),
}));

const put    = (item, condition) => ddb.send(new PutCommand({
  TableName: TABLE, Item: item,
  ...(condition ? { ConditionExpression: condition } : {}),
}));

const update = (key, expr, names, values, condition) => ddb.send(new UpdateCommand({
  TableName: TABLE, Key: key,
  UpdateExpression:    expr,
  ExpressionAttributeNames:  names,
  ExpressionAttributeValues: values,
  ...(condition ? { ConditionExpression: condition } : {}),
  ReturnValues: 'ALL_NEW',
}));

const remove = (key) => ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));

const query  = (params) => ddb.send(new QueryCommand({ TableName: TABLE, ...params }));

/**
 * Batch-write items (put or delete) handling the 25-item limit automatically.
 * @param {object[]} requests — each is { PutRequest: {Item} } or { DeleteRequest: {Key} }
 */
async function batchWrite(requests) {
  const chunks = [];
  for (let i = 0; i < requests.length; i += 25) chunks.push(requests.slice(i, i + 25));
  for (const chunk of chunks) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: chunk } }));
  }
}

module.exports = { TABLE, keys, get, put, update, remove, query, batchWrite };
