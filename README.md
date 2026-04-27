# Ants Dispatch
A serverless newsletter sender for small admin teams. Compose HTML or
WYSIWYG, segment subscribers by tag, send (or schedule) campaigns through
SES, track delivery / opens / clicks / bounces, and self-serve unsubscribes.

<img width="1183" height="654" alt="Screenshot 2026-04-26 at 8 59 53 PM" src="https://github.com/user-attachments/assets/3f1e850d-6144-42c8-8009-895625a40a39" />
<br>
<img width="1182" height="650" alt="Screenshot 2026-04-26 at 8 53 26 PM" src="https://github.com/user-attachments/assets/bbf8a77b-29b1-42e5-aad0-e532352f21fd" />

The default brand prefix is **Ants** (configurable per build via
`VITE_APP_BRAND` — see [Brand](#brand)).

## Tech stack

| Layer            | Choice                                                              |
|------------------|---------------------------------------------------------------------|
| **Frontend**     | Vite, React 18, TypeScript, TanStack Router, TanStack Query, TipTap |
| **Auth**         | AWS Cognito (Hosted UI, OAuth 2.0 PKCE)                             |
| **API**          | API Gateway (Regional REST) → Node.js 20 Lambdas, AWS WAF v2        |
| **Data**         | DynamoDB single-table design with GSI1, streams, PITR, TTL          |
| **Async work**   | SQS (`import`, `send`) + dead-letter queues                         |
| **Email**        | SES v2 (DKIM, custom MAIL-FROM, configuration set + event tracking) |
| **Event ingest** | SES → SNS → Lambda                                                  |
| **Scheduling**   | EventBridge Scheduler (one-time at-time triggers)                   |
| **Edge**         | CloudFront + ACM (DNS-validated cert, single distribution)          |
| **Storage**      | S3 (SPA bundle + archive bucket for assets / rendered HTML)         |
| **IaC**          | AWS CDK v2 (TypeScript)                                             |
| **Runtime lang** | TypeScript everywhere — Node 20.x for Lambdas, ESM for SPA          |

## Architecture

```
                      ┌─────────────────────────┐
   user ─────HTTPS───▶│  CloudFront + ACM        │  ── /          ──▶ S3 (SPA)
                      │  + AWS WAF (regional)    │  ── /archive/* ──▶ S3 (assets)
                      └────────────┬─────────────┘  ── /admin/*   ──▶ API GW (auth)
                                   │                ── /public/*  ──▶ API GW
                                   ▼
                      ┌──────────────────────────┐
                      │  API Gateway + Lambdas    │
                      │  templates · contacts ·   │
                      │  imports · campaigns ·    │  ─ DDB (single table, GSI1)
                      │  audience · assets ·      │  ─ S3 (archive, imports)
                      │  suppressions · u (pub)   │  ─ SES v2 (send)
                      └──────┬─────┬─────┬───────┘  ─ SQS (send, import)
                             │     │     │          ─ EventBridge Scheduler
                             ▼     ▼     ▼
            ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
            │ worker-import  │ │ worker-send  │ │ worker-dispatch  │
            │  (SQS → DDB)   │ │ (SQS → SES)  │ │ (Scheduler → SQS)│
            └────────────────┘ └──────────────┘ └──────────────────┘
                                       │
                                       ▼
                                  ┌─────────┐     SES events
                                  │  SES v2 │ ──▶ SNS ──▶ worker-events ──▶ DDB stats
                                  └─────────┘
```

### CDK stacks

| Stack            | Purpose                                                                          |
|------------------|----------------------------------------------------------------------------------|
| **Auth**         | Cognito User Pool + Hosted UI domain + SPA app client                            |
| **Storage**      | S3 buckets: `spa` (assets), `archive` (rendered HTML + uploaded images)          |
| **Data**         | DynamoDB single table, SQS `send` queue + DLQ                                    |
| **Processing**   | S3 `imports` bucket + SQS `import` queue + `worker-import` Lambda                |
| **Delivery**     | SES domain identity + DKIM + custom MAIL-FROM + ConfigurationSet + `worker-send` |
| **Events**       | SNS `ses-events` topic + `worker-events` Lambda (open/click/bounce/etc.)         |
| **Api**          | API Gateway + WAF + 8 Lambdas + EventBridge Scheduler + `worker-dispatch`        |
| **Edge**         | CloudFront distribution + ACM cert (single origin fronts SPA + buckets + API)    |

### Scaling to tens of thousands of recipients per send

Out of the box this app targets ~10K-recipient campaigns. The pipeline below
documents what's already in place to push that to 50K+ and what to tune as
you grow. Numbers assume a single tenant; multi-tenancy needs separate
quotas/accounts.

**Send-time fan-out is fully async.** `POST /admin/campaigns/{id}/send` no
longer materializes the audience inline — it claims the campaign as
`queueing`, drops a single `{campaignId}` message into the **enqueue queue**,
and returns. The dedicated **worker-enqueue Lambda** (15-minute timeout)
consumes that message and runs the heavy work: audience materialize → 25-row
DynamoDB `BatchWrite` loop for RCPT rows → 10-message `SendMessageBatch`
loop into the **send queue**. This decouples API Gateway's 29s ceiling from
the size of the audience and lets a 50K-row campaign finish enqueue in a
few minutes rather than timing out.

**SQS payloads are slim.** Each per-recipient message in the send queue
carries only `{campaignId, email}` (~80 bytes). `worker-send` pulls the
campaign's `subject` + `html` once per Lambda instance from the META row
(60s module-level cache) and renders the unsubscribe + view-in-browser
links per recipient. This keeps every batch under SQS's 256 KB ceiling
even with large HTML bodies and removes a multiplier on enqueue latency.

**SES is the real throughput cap.** Default sandbox is 200/day at 14/sec —
unusable for production. Once the account is moved to production access the
starting tier is typically 50K/day at 14/sec; ask AWS for a quota increase
to ~50–200/sec before the first big send. At 100/sec, 50,000 sends finish in
about 8.5 minutes. Track `Reputation/Bounce` and `Reputation/Complaint` on
the configuration set; a spike pauses sending automatically.

**Lambda concurrency.** `worker-send` has no reserved concurrency, so it
scales up to the account-wide unreserved pool (default 1,000). On a fresh
account that pool may be smaller — request an increase if you observe
throttling on the SQS event source. `worker-enqueue` is intentionally
serial (SQS `batchSize: 1` plus a campaign-status idempotency check) so
two sends of the same campaign can't double-enqueue recipients.

**DynamoDB hot-partition risk.** Every send/open/click/bounce/unsubscribe
event touches the same `CAMPAIGN#{id}/STATS` item. DDB caps a single
partition at ~1,000 WCU/sec, and a sustained burst of 50K events arriving
within ~1 minute can throttle. DDB retries internally so counts won't be
lost, but worker-events latency will spike. If you see this, shard the
counter into N items (`STATS#0`..`STATS#9`) and sum at read time. The
recipient rows (`RCPT#{email}`) are already well-distributed across
partitions because the email is in the SK.

**Retry / DLQ topology.**

| Queue          | Visibility | maxReceive | DLQ                  |
|----------------|------------|------------|----------------------|
| `enqueue`      | 15 min     | 2          | `enqueue-dlq` (14d)  |
| `send`         | 60 s       | 5          | `send-dlq` (14d)     |
| `import` (CSV) | …          | …          | `import-dlq`         |

The enqueue queue's low retry count is deliberate: re-running materialize
after a partial enqueue would risk duplicate sends. The send queue's count
is higher because each retry only affects one recipient and SES tolerates
brief outages.

**What to revisit before pushing past 100K.**

- Pre-warm SES (gradual ramp over a few campaigns) and request a higher
  per-second tier.
- Shard the campaign STATS counter (see above).
- Move the `unsubscribeSecret` env-var injection in CDK to a runtime fetch
  (`Secret.fromSecretCompleteArn` + cache); the current `unsafeUnwrap()`
  bakes the secret into the Lambda template.
- Reserve concurrency on `worker-send` so a noisy neighbor in the same
  account can't crowd it out — requires raising the account-level
  unreserved concurrency floor (currently the deploy can't reserve any
  slots without bumping that quota).
- Consider an SES Configuration Set sending pool with dedicated IPs once
  monthly volume crosses ~500K — improves deliverability and isolates
  reputation from shared-IP traffic.

### Repo layout

```
infra/                CDK app (8 stacks above)
services/
  api-admin/          Lambdas behind /admin/* (templates, contacts, …)
  api-public/         Lambdas behind /public/* (unsubscribe)
  worker-import/      SQS-triggered CSV → contacts upsert
  worker-send/        SQS-triggered SES SendEmail
  worker-events/      SNS-triggered SES event ingest → DDB stats
  worker-dispatch/    EventBridge Scheduler-triggered scheduled-send
packages/
  shared/             Shared types/utils (small)
web/                  Vite + React SPA
docs/                 Architecture notes
```

## Cost

Rough monthly estimate at **50,000 sends** in `us-east-1` (on-demand /
pay-per-use pricing, single environment, ~5 admin users, 50 KB average HTML
body, ~25% open rate, ~5% click rate):

| Service                  | What's billed                       | Est. cost |
|--------------------------|-------------------------------------|----------:|
| SES v2                   | 50K outbound emails @ $0.10/1K      |     $5.00 |
| AWS WAF                  | Web ACL + ~3 rules                  |     $8.00 |
| CloudWatch + X-Ray       | ~130K traces + log ingest           |     $1.00 |
| CloudFront               | ~5 GB (mostly view-in-browser)      |     $0.60 |
| DynamoDB (on-demand)     | ~250K writes + 100K reads           |     $0.50 |
| Secrets Manager          | 1 secret + API calls                |     $0.45 |
| SNS                      | ~250K Lambda deliveries             |     $0.30 |
| API Gateway (REST)       | ~75K requests                       |     $0.30 |
| Lambda                   | ~350K invocations across all fns    |     $0.30 |
| S3                       | ~100 MB storage + GETs              |     $0.20 |
| SQS                      | ~150K ops across all queues         |     $0.10 |
| EventBridge Scheduler    | A handful of scheduled sends        |    <$0.10 |
| Cognito                  | ~5 monthly active admin users       |        $0 |
| Route 53 / ACM           | External DNS / DNS-validated cert   |        $0 |
| **Total**                |                                     | **~$16**  |

Per-1K-send unit cost ≈ **$0.32** at this volume, dominated by SES +
WAF amortization. Things worth knowing:

- **WAF is half the fixed cost** ($8/$16). If you don't need it for
  compliance/reputation, drop it and replace with API Gateway per-IP
  throttling — that path is free and shaves the bill to ~$8/month.
- **SES is the only volume-linear cost worth caring about.** At 100K
  sends/month → ~$21; at 500K → ~$66. Everything else stays roughly
  flat until ~5–10× this scale.
- **Apple Mail Privacy Protection** roughly 2–3× the Open events SES
  emits (and therefore worker-events Lambda + DDB writes). The estimate
  already bakes in ~5 events per send.
- **Dedicated SES IPs** ($24.95/month each) only matter at sustained
  100K+/month or when reputation isolation is required. Not needed at
  50K.
- **AWS free tier** covers a meaningful chunk of Lambda, DDB, and API
  Gateway in your first 12 months on AWS — first-year cost is closer to
  **$10–12**.
- **CloudFront cost scales with view-in-browser usage**, not with sends.
  A widely-shared message link could push CloudFront higher than the
  per-recipient render estimate, but it's still tiny compared to SES.

This is AWS infra only — domain registration, deliverability monitoring
tools, and any human ops time are extra. Multi-environment (dev + prod)
roughly doubles the fixed costs (WAF, Secrets Manager) but not the
volume-linear ones.

## Prerequisites

- **Node.js 20+** (`node -v`)
- **AWS account** with admin access; `aws configure` set up to it
- **AWS CDK v2**: `npm i -g aws-cdk` (or use the project-local `npx cdk`)
- A **domain you control DNS for** (the deploy issues an ACM cert via DNS validation and points a CNAME at CloudFront)

## Installation (first deploy)

### 1. Clone and install

```bash
git clone <this-repo> dispatch
cd dispatch
npm install            # installs all workspaces
```

### 2. Bootstrap CDK (once per account/region)

```bash
cd infra
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

### 3. Pick your domain

Edit `infra/cdk.json` and set the domain you'll deploy to:

```json
{
  "context": {
    "domain.dev": "dispatch.your-domain.com",
    "domain.prod": "dispatch.your-domain.com"
  }
}
```

(You can also pass `-c domain=…` on the CLI or set `DISPATCH_DOMAIN`.)

### 4. Deploy the stacks

```bash
cd infra
npm run deploy:dev
```

The deploy will pause when it reaches the `Edge` stack to wait for ACM
certificate validation. In a second terminal, fetch the validation CNAME and
publish it at your DNS provider:

```bash
CERT=$(aws cloudformation describe-stack-resources \
  --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query "StackResources[?LogicalResourceId=='CertE7D9FC49'].PhysicalResourceId" \
  --output text)
aws acm describe-certificate --certificate-arn "$CERT" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Add the returned `Name` → `Value` as a CNAME record. CDK resumes within ~2
minutes once the cert validates.

### 5. Point your domain at CloudFront

After Edge finishes (~5–10 min), grab the distribution domain:

```bash
aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionDomain`].OutputValue' --output text
```

Add a CNAME at your DNS provider:

| Type  | Name       | Value                       |
|-------|------------|-----------------------------|
| CNAME | `dispatch` | `d1a2b3c4xxxxxx.cloudfront.net` |

### 6. Wire SES DNS (so you can actually send)

After Delivery deploys, the SES console shows pending DKIM tokens for your
domain. Publish at your DNS:

- **3 × CNAME** for DKIM: `<token>._domainkey.dispatch.your-domain.com → <token>.dkim.amazonses.com`
- **1 × TXT** for SPF on MAIL-FROM: `mail.dispatch.your-domain.com → "v=spf1 include:amazonses.com -all"`
- **1 × MX** for MAIL-FROM bounces: `mail.dispatch.your-domain.com → 10 feedback-smtp.us-east-1.amazonses.com`
- **1 × TXT** for DMARC: `_dmarc.dispatch.your-domain.com → "v=DMARC1; p=none"`

Then request SES production access through the AWS console (otherwise you
can only send to verified test recipients).

### 7. Create the first admin user

```bash
POOL=$(aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Auth \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)

aws cognito-idp admin-create-user \
  --user-pool-id $POOL \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id $POOL \
  --username you@example.com \
  --password 'YourTempPassword123!' --permanent
```

### 8. Build + deploy the SPA

The SPA reads its config at build time from `web/.env.production`:

```bash
cd web
cp .env.example .env.production

# Fill in from CloudFormation outputs:
aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Auth --region us-east-1 \
  --query 'Stacks[0].Outputs' --output table
```

Set:
- `VITE_API_BASE=` (empty — same-origin via CloudFront)
- `VITE_COGNITO_DOMAIN=<HostedUiDomain>`
- `VITE_COGNITO_CLIENT_ID=<UserPoolClientId>`
- `VITE_REDIRECT_URI=https://dispatch.your-domain.com/auth/callback`
- `VITE_APP_BRAND=Ants` *(optional; default is "Ants")*

Then build + push:

```bash
cd web
./deploy.sh dev   # builds, syncs to S3, invalidates CloudFront
```

Visit `https://dispatch.your-domain.com`, sign in with the admin user.

## Local development

```bash
cd web
cp .env.example .env.local      # set VITE_API_BASE to your deployed API URL
npm run dev                     # → http://localhost:5173
```

The Cognito redirect URI for localhost (`http://localhost:5173/auth/callback`)
is registered by `auth-stack.ts` already; sign-in works against the deployed
user pool.

## Subsequent deploys

The repo root has a single `deploy.sh` that ships infra (CDK) and the SPA in
one shot. It delegates the SPA half to `web/deploy.sh`.

```bash
./deploy.sh                       # env=dev, deploys all stacks + SPA
./deploy.sh prod                  # env=prod
./deploy.sh dev --infra-only      # CDK only
./deploy.sh dev --web-only        # SPA only
./deploy.sh dev --skip-build      # SPA: reuse existing web/dist
./deploy.sh dev --stacks "ApiStack DeliveryStack"   # subset of CDK stacks
```

For finer control you can still call the underlying scripts directly:

```bash
cd infra && npx cdk deploy <StackName> -c env=dev
cd web && ./deploy.sh dev
```

### `dev` vs `prod`

The env flag drives five things:

1. **Stack name prefix.** `NdaDispatch-Dev-*` vs `NdaDispatch-Prod-*` — each
   env has its own CloudFormation stacks, S3 SPA bucket, CloudFront
   distribution, DynamoDB table, and Lambdas. They share nothing.
2. **Domain context.** `infra/lib/config.ts` reads `domain.dev` vs
   `domain.prod` from `infra/cdk.json`. Today both default to the same host;
   set them differently if you want separate hostnames per env.
3. **Resource retention.** `removalOnDestroy = envName === 'dev'`. Dev
   resources (S3 buckets, log groups, etc.) get `RemovalPolicy.DESTROY` so
   `cdk destroy` cleans them out. Prod uses `RETAIN` so a teardown can't
   delete user data by accident.
4. **CDK approval gate.** `npm run -w infra deploy:dev` uses
   `--require-approval never`; `deploy:prod` uses `--require-approval
   broadening`, which prompts before any IAM-broadening change.
5. **`web/deploy.sh` lookup.** It queries CloudFormation outputs
   (`SpaBucketName`, `DistributionId`, `PublicUrl`) by the env-specific stack
   prefix; pointing it at the wrong env will either fail to resolve outputs
   or push the SPA into the wrong bucket.

> ⚠️ The root `deploy.sh` currently passes `--require-approval never` for
> both envs, which silences the prod approval prompt that
> `npm run -w infra deploy:prod` would enforce. If you want the prod prompt
> back, run `cd infra && npm run deploy:prod` instead.

## Configuration

### Brand

The display name shown in the sidebar and browser tab is `<prefix> Dispatch`.
The prefix is configurable; "Dispatch" is fixed.

```bash
# web/.env.production
VITE_APP_BRAND=NDA           # → "NDA Dispatch", collapsed mark "N•"
```

Defaults to `Ants` if unset. Rebuild + redeploy the SPA to apply.

### Domain

Set in `infra/cdk.json` under `context.domain.dev` / `context.domain.prod`,
or pass `-c domain=…` on the CLI. The same hostname is used for the SPA, the
admin/public APIs (path-based routing through CloudFront), the SES sending
identity, and Cognito's allowed callback URL.

### Optional CDK context keys

| Key                  | Default        | Use                                                  |
|----------------------|----------------|------------------------------------------------------|
| `region`             | `us-east-1`    | Where everything deploys                             |
| `mailFromSubdomain`  | `mail`         | SES MAIL-FROM subdomain (`mail.<domain>`)            |
| `rootDomain`         | inferred       | Override if `<domain>` isn't a 2-part subdomain      |

## Deeper docs

- **`infra/README.md`** — per-stack notes, walkthrough for SES DNS, smoke-test curl scripts
- **`web/README.md`** — SPA-specific config, route table, known gaps
- **`docs/`** — data-model + design notes

## License

Copyright © 2026 ScientHouse LLC

Released under the **MIT License** — see [`LICENSE`](./LICENSE) for the full
text. You may use, copy, modify, merge, publish, distribute, sublicense, and
sell copies of the software, including in proprietary or SaaS products,
provided the copyright notice and the license text are kept in any
substantial portion of the software you distribute.

### Third-party notices

This project bundles or links to permissively-licensed dependencies (React,
TanStack, TipTap, AWS SDK, AWS CDK, Zod, Vite, etc.) under MIT or Apache-2.0,
and uses Source Serif 4, Inter, and JetBrains Mono via Google Fonts under the
SIL Open Font License 1.1. Run `npx license-checker --production --summary`
from the repo root to regenerate the full attribution list.
