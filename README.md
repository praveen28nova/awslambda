# MailBlast v2 — Production Backend

> Permission-based bulk email platform: AWS Lambda + SES + SQS + DynamoDB + Cognito

---

## Architecture

```
Browser / API Client
        │
        ▼
┌─────────────────────┐
│   API Gateway       │  Cognito JWT auth · throttle · CORS
│   (REST, prod stage)│
└──────┬──────────────┘
       │ routes
       ▼
┌───────────────────────────────────────────────────────────┐
│  Lambda Functions                                          │
│                                                            │
│  campaigns handler  ─── DynamoDB (single-table)           │
│  recipients handler ─── DynamoDB + suppression list       │
│  preview handler    ─── DynamoDB (read-only)              │
│  unsubscribe handler ── DynamoDB + suppression list       │
└──────────────────────────┬────────────────────────────────┘
                           │ SendMessage
                           ▼
              ┌────────────────────────┐
              │ SQS FIFO Queue         │  1 msg per campaign
              │ (MailBlastCampaigns)   │  3 retries → DLQ
              └───────────┬────────────┘
                          │ trigger (batch=1)
                          ▼
              ┌────────────────────────┐
              │  Worker Lambda         │  paginate recipients
              │  (15-min timeout)      │  rate-limit to SES quota
              └───────────┬────────────┘
                          │ SendEmail
                          ▼
              ┌────────────────────────┐
              │   AWS SES              │  verified sender domain
              └───────────┬────────────┘
                          │ notifications
                          ▼
              ┌────────────────────────┐
              │ SNS Topic              │  bounce/complaint/delivery
              │ (MailBlastEvents)      │
              └───────────┬────────────┘
                          │ invoke
                          ▼
              ┌────────────────────────┐
              │ Events Lambda          │  auto-suppress hard bounces
              │                        │  + complaints
              └────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **Single-table DynamoDB** | All entities in one table; GSI1 lists campaigns by account without scan |
| **SQS FIFO** | One campaign per message group; ordered delivery; deduplication ID prevents double-enqueue |
| **Per-recipient status check** | Idempotency — worker reads recipient status before each SES call; retries are safe |
| **Cognito JWT authorizer** | Credentials never touch Lambda code; API GW validates before invocation |
| **BYPASS_AUTH env var** | Local dev without Cognito; gate is `"true"` string only — can't be injected via API |
| **arm64 / Graviton** | 20% cheaper Lambda compute at same performance |
| **PITR + Retain** | DynamoDB table cannot be accidentally deleted in prod |

---

## Project Structure

```
lambda/
├── src/
│   ├── lib/
│   │   ├── auth.js          # withAuth() middleware, assertCampaignOwner()
│   │   ├── clients.js       # Singleton AWS SDK v3 clients
│   │   ├── dynamo.js        # Single-table key builders + DDB wrappers
│   │   ├── logger.js        # Structured JSON logger (scrubs PII/secrets)
│   │   ├── response.js      # Typed HTTP response helpers
│   │   ├── suppression.js   # Suppress/check/bulk-check/unsuppress
│   │   └── validate.js      # Email validation, normalisation, dedup
│   └── handlers/
│       ├── campaigns.js         # CRUD + status machine
│       ├── campaignRouter.js    # GET/PATCH/DELETE/preview dispatcher
│       ├── events.js            # SES bounce/complaint/delivery processor
│       ├── preview.js           # Render body without sending
│       ├── recipients.js        # JSON add, CSV import, list
│       ├── recipientRouter.js   # POST/POST-csv/GET dispatcher
│       ├── unsubscribe.js       # Link handler (HTML) + API handler
│       ├── unsubscribeRouter.js # GET (public) / POST (auth) dispatcher
│       └── worker.js            # SQS worker + DLQ processor
├── tests/
│   ├── campaigns.test.js
│   ├── recipients.test.js
│   ├── suppression.test.js
│   └── worker.test.js
├── template.yaml        # SAM CloudFormation (all resources)
├── env.local.json       # Local dev env vars (sam local start-api)
├── package.json
├── .eslintrc.json
└── .gitignore
```

---

## SES Setup (REQUIRED before deploying)

### 1. Verify sender identity
```
AWS Console → SES → Verified Identities → Create identity
```
- Choose **Domain** (recommended for production) or **Email address**
- Follow DNS/email verification steps

### 2. Request Production Access (exit Sandbox)
While in Sandbox, **both** sender AND every recipient must be verified.

```
AWS Console → SES → Account dashboard → Request production access
```
Fill in the form; explain your use case and opt-in process. Approval takes 24–48 hours.

### 3. Create a Configuration Set
```
AWS Console → SES → Configuration sets → Create configuration set
```
- Name: (use the value you'll pass as `SESConfigurationSet` parameter)
- Add an event destination: choose **SNS** → select `MailBlastEvents-{env}` topic
- Enable: **Bounces, Complaints, Deliveries**

---

## Local Development

### Prerequisites
- Node 18+
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- [Docker](https://www.docker.com/) (for `sam local`)
- (Optional) [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html)

### Steps

```bash
# 1. Install dependencies
cd lambda
npm install

# 2. Start DynamoDB Local (optional but recommended)
docker run -p 8000:8000 amazon/dynamodb-local

# 3. Create the local table (run once)
aws dynamodb create-table \
  --table-name MailBlast-dev \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes '[
    {"IndexName":"GSI1","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}
  ]' \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000

# 4. Start local API (BYPASS_AUTH=true skips Cognito)
sam build && sam local start-api --env-vars env.local.json

# 5. Run tests
npm test

# 6. Lint
npm run lint
```

---

## Deployment

```bash
# First deploy (guided — creates/saves samconfig.toml)
sam build
sam deploy --guided

# Subsequent deploys
sam build && sam deploy

# Deploy to staging
sam deploy --config-env staging \
  --parameter-overrides Environment=staging AppBaseUrl=https://staging.example.com
```

### Post-deploy steps
1. Copy `EventsTopicArn` from SAM outputs
2. Open **SES → Configuration Sets → your set → Event destinations**
3. Edit the SNS destination → update the ARN to the copied value
4. Copy `ApiEndpoint` and paste it into the frontend Settings page
5. Copy `CognitoClientId` and use it in your frontend's Cognito auth flow

---

## API Reference

All endpoints require an `Authorization: Bearer <Cognito-ID-token>` header
**except** `GET /unsubscribe` (public).

### Base URL
```
https://{api-id}.execute-api.{region}.amazonaws.com/{env}
```

---

### Campaigns

#### `POST /campaigns` — Create campaign

```json
{
  "subject":    "Your email subject (required)",
  "fromEmail":  "sender@verified-domain.com (required, must be SES-verified)",
  "fromName":   "Company Name (required)",
  "replyTo":    "replies@domain.com (optional)",
  "htmlBody":   "<p>HTML body (required)</p>",
  "textBody":   "Plain-text fallback (optional)",
  "scheduledAt": "2024-12-01T10:00:00Z (optional ISO 8601 — sets status=SCHEDULED)"
}
```

**201 Created**
```json
{
  "campaign": {
    "campaignId": "uuid",
    "status": "DRAFT",
    "subject": "...",
    "fromEmail": "...",
    "recipientCount": 0,
    "createdAt": "..."
  }
}
```

> ⚠️ `htmlBody` and `textBody` are **never** returned in API responses.

---

#### `GET /campaigns` — List campaigns

Query params: `limit` (1–100, default 20), `nextToken` (pagination cursor)

---

#### `GET /campaigns/{id}` — Get campaign

---

#### `PATCH /campaigns/{id}/status` — Transition status

```json
{ "status": "SCHEDULED" }
```

**Status machine:**
```
DRAFT ──────────────────────► SCHEDULED ──► SENDING ──► COMPLETED
  │                                │           │
  └────────────────────────────────┴───► PAUSED ──► SENDING (resume)
  │                                            │
  └────────────────────────────────────────────┴──► CANCELLED
```

Transitioning to `SENDING` enqueues the campaign to SQS immediately.

---

#### `DELETE /campaigns/{id}` — Delete campaign

Only `DRAFT` or `CANCELLED` campaigns can be deleted.

---

#### `GET /campaigns/{id}/preview` — Preview rendered body

Returns `htmlBody` (with unsubscribe footer appended) + `textBody`. No email is sent.

---

### Recipients

#### `POST /campaigns/{id}/recipients` — Add recipients (JSON)

```json
{
  "recipients": ["alice@example.com", "bob@example.com"]
}
```

- Max 1 000 per call; call multiple times for large lists
- Validates, deduplicates, and suppression-checks before writing
- Campaign must be `DRAFT` or `SCHEDULED`

**201 Created**
```json
{
  "added": 2,
  "skippedInvalid": 0,
  "skippedSuppressed": 0,
  "total": 2
}
```

---

#### `POST /campaigns/{id}/recipients/csv` — Bulk import via CSV

- Body: raw CSV content (or base64-encoded if sent through API GW binary media)
- Max 5 MB
- Must contain an `email` column; `name` is optional

```csv
email,name
alice@example.com,Alice
bob@example.com,Bob
```

---

#### `GET /campaigns/{id}/recipients` — List recipients

Query params: `limit` (1–500, default 50), `nextToken`

---

### Unsubscribe

#### `GET /unsubscribe?token=<token>` — One-click unsubscribe (public)

Token is base64url-encoded `{ "email": "...", "campaignId": "..." }`.
Returns an HTML confirmation page. Suppresses the address immediately.

#### `POST /unsubscribe` — Operator-initiated suppression (authenticated)

```json
{
  "email": "user@example.com",
  "campaignId": "uuid (optional)",
  "reason": "manual (optional)"
}
```

---

## Security Notes

| Concern | Mitigation |
|---|---|
| Credentials in code | None — all auth via IAM execution role + Cognito |
| Secrets in env | No secrets stored in env vars; API keys not used in Lambda code |
| Email body logging | Logger explicitly strips `body`, `htmlBody`, `textBody` fields |
| Recipient email logging | Only logged at DEBUG level (disabled in prod via LOG_LEVEL=info) |
| Tenant isolation | Every campaign read/write checks `accountId === caller's accountId` |
| Unsubscribe token forgery | Tokens are base64 (not signed); upgrade to HMAC-SHA256 for higher security |
| SES rate abuse | SQS FIFO queues one job at a time per account; SEND_RATE_PER_SEC caps throughput |
| API abuse | API GW usage plan throttle (50 rps burst, 100 burst); Cognito JWT required |

---

## Running Tests

```bash
npm test                    # run all tests
npm test -- --coverage      # with coverage report
npm test -- --testPathPattern campaigns  # single file
```

### Test Results (expected)

```
PASS tests/campaigns.test.js
PASS tests/suppression.test.js
PASS tests/recipients.test.js
PASS tests/worker.test.js

Test Suites: 4 passed, 4 total
Tests:       ~28 passed
```
# awslambda
# awslambda
