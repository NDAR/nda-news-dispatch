# ScientHouse Dispatch

A serverless newsletter sender for small admin teams. Compose HTML or
WYSIWYG, segment subscribers by tag, send (or schedule) campaigns through
SES, track delivery / opens / clicks / bounces, and self-serve unsubscribes.

The default brand prefix is **ScientHouse** (configurable per build via
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
- `VITE_APP_BRAND=ScientHouse` *(optional; default is "ScientHouse")*

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

Defaults to `ScientHouse` if unset. Rebuild + redeploy the SPA to apply.

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

Copyright © 2026 ScientHouse contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU Affero General Public License v3.0** as published by
the Free Software Foundation. See [`LICENSE`](./LICENSE) for the full text.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE.

### What AGPL-3.0 means in practice

- You can run, study, modify, and redistribute the source freely.
- If you **modify the code and let other people use the modified version over
  a network** (e.g. host it as a SaaS), you must offer those users access to
  the corresponding source — including your modifications — under the same
  AGPL-3.0 terms.
- Internal use within an organization (no third-party network access) does
  not trigger the source-disclosure requirement.
- Combining this code with permissively-licensed code (MIT/Apache-2.0) is
  fine; the combined work is distributed under AGPL-3.0.

If those terms don't fit your use case, contact the maintainers about a
commercial license.

### Third-party notices

This project bundles or links to permissively-licensed dependencies (React,
TanStack, TipTap, AWS SDK, AWS CDK, Zod, Vite, etc.) under MIT or Apache-2.0,
and uses Source Serif 4, Inter, and JetBrains Mono via Google Fonts under the
SIL Open Font License 1.1. Run `npx license-checker --production --summary`
from the repo root to regenerate the full attribution list.
