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
| **Frontend**     | Vite, React 18, TypeScript, TanStack Router, TanStack Query, TinyMCE 7 |
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

### Scalability

Designed to handle 50K-recipient sends without blocking the API or
overrunning AWS limits. The key levers:

- **Async send fan-out.** `POST /admin/campaigns/{id}/send` claims the
  campaign as `queueing`, drops one `{campaignId}` message onto the
  enqueue queue, and returns. The 15-minute `worker-enqueue` Lambda does
  the heavy work — audience materialize → 25-row DDB `BatchWrite` for
  RCPT rows → 10-message `SendMessageBatch` into the send queue —
  decoupling the audience size from API Gateway's 29s ceiling.
- **Slim SQS payloads.** Per-recipient messages carry only
  `{campaignId, email}` (~80 bytes). `worker-send` loads `subject`/`html`
  once per Lambda instance via a 60s module cache, so batches stay well
  under SQS's 256 KB ceiling regardless of body size.
- **Single GSI scan for audience filtering.** Suppression checks read
  the denormalized `suppressedGlobal` / `suppressedTypes` hints on
  CONTACT PROFILE rows instead of querying SUPP partitions per
  recipient, keeping materialize O(N) over one GSI page rather than
  O(N) `Query` calls.
- **Horizontally-scaling workers.** `worker-send` has no reserved
  concurrency and scales up to the account's unreserved Lambda pool;
  `worker-enqueue` is intentionally serial (`batchSize: 1` + status
  idempotency check) so a duplicate trigger can't double-enqueue.
- **DDB on-demand + per-link counter rows.** No capacity planning;
  open/click counters are spread across `LINK#<hash>` rows so a single
  link can't dominate a partition. The `CAMPAIGN#{id}/STATS` item is
  the one known hot spot — shard into `STATS#0..9` if a 50K burst ever
  throttles.
- **Retry topology.** `enqueue` queue: visibility 15 min, `maxReceive
  2`, DLQ. `send` queue: visibility 60 s, `maxReceive 5`, DLQ. Low
  enqueue retries avoid duplicate sends; higher send retries tolerate
  brief SES blips per recipient.
- **SES is the actual cap.** Default production tier is ~14/sec; ask
  AWS to raise it to 50–200/sec before the first large send. At
  100/sec, 50K finishes in ~8.5 minutes. The Configuration Set's
  reputation alarms auto-pause sending if bounce/complaint rates spike.

Past ~100K/send, also: pre-warm SES with a graduated ramp, reserve
concurrency on `worker-send`, and consider a dedicated-IP SES pool
once monthly volume crosses ~500K.

### Per-newsletter unsubscribes

Suppressions are layered. Both layers share the `SUPP#<email>` partition:

| Scope | Triggered by | Effect |
|---|---|---|
| `TYPE#GLOBAL` | hard bounces, complaints, operator stop-everything | Blocks every send to this email |
| `TYPE#<typeId>` | footer / native-client unsubscribe link, operator per-type add | Blocks only campaigns whose `typeId` matches |

A send is dropped if either layer matches. CONTACT PROFILE rows carry
`suppressedGlobal: bool` and `suppressedTypes: StringSet<typeId>`
denormalized hints so the audience filter remains a single GSI scan.
The unsubscribe confirmation page names the type and offers a
secondary "Unsubscribe from everything" button that escalates to
`TYPE#GLOBAL`. SES bounces and complaints always write `TYPE#GLOBAL`
because reputation signals are per-domain, not per-newsletter.

### Resilience to email security scanners

Enterprise mail-security gateways (Microsoft Defender Safe Links,
Proofpoint URL Defense, Mimecast, Barracuda, Cisco Talos, etc.) crawl
every link in inbound mail before delivery. Untreated, those crawls
inflate Open / Click stats and — worst of all — fire RFC 8058 one-click
unsubscribes that opt real subscribers out without their action.

Three defenses, applied unconditionally:

1. **No `List-Unsubscribe-Post: One-Click` header.** Native client
   "Unsubscribe" buttons still surface via the bare `List-Unsubscribe`
   URL, but the URL routes through our two-step confirmation page
   instead of accepting unattended POSTs.
2. **Two-step unsubscribe.** `GET /public/u` renders a "Yes,
   unsubscribe" button and writes nothing. Bare `POST /public/u`
   returns `200 OK` and writes nothing. Only `POST /public/u?confirm=1`
   (the form submission from the confirmation page) writes the SUPP
   row.
3. **Scanner detection in `worker-events`.** Open and Click events
   that arrive within 30 s of the recipient's `deliveredAt`/`queuedAt`
   are dropped (real users don't open mail in <30 s). Click events
   whose SES `userAgent` matches a known scanner regex (Defender,
   Proofpoint, Mimecast, Barracuda, Cisco Talos, Sophos, Bitdefender,
   Zscaler, headless browsers, `wget`/`curl`/`python-requests`, …) are
   also dropped. Both filters fail open if the RCPT row is missing so
   legitimate engagement is never silently lost.

### Public subscribe page

A linkable, unauthenticated sign-up form lives at
`https://<your-domain>/subscribe` (or `/subscribe?type=<typeId>` to
preselect a newsletter). The Settings page in the SPA lists the
copy-paste URLs for the generic form and each active type. Submissions
are double opt-in: the form writes a `PENDING_OPTIN#<email>` row with a
48 h DDB TTL and emails an HMAC-signed confirmation link; only on click
does the contact land on the active list.

Bot resistance, layered:

1. **Honeypot field.** A hidden `website` input — bots that auto-fill
   every field trip it; the response looks like success so they don't
   probe further.
2. **WAF rate limit.** 60 sign-ups / 5 min / IP on `/public/subscribe`,
   on top of the existing `/public/*` cap.
3. **Cloudflare Turnstile (optional).** Set `VITE_TURNSTILE_SITE_KEY`
   for the SPA build and `TURNSTILE_SECRET` on the `SubscribeFn`
   Lambda env to add an invisible challenge. Without these, the form
   still works on the other three layers.
4. **Double opt-in confirmation email.** Bots that beat 1–3 still need
   to click the link sent to the address they typed — which won't
   happen unless they own the inbox.
5. **Suppression check.** Globally-suppressed addresses are silently
   swallowed at submission time so the endpoint can't be used to probe
   the suppression list.

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
  --stack-name AntsDispatch-Dev-Edge --region us-east-1 \
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
aws cloudformation describe-stacks --stack-name AntsDispatch-Dev-Edge --region us-east-1 \
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
POOL=$(aws cloudformation describe-stacks --stack-name AntsDispatch-Dev-Auth \
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

The user pool requires TOTP MFA. On first sign-in via the Hosted UI,
the admin will be prompted to scan a QR code with an authenticator app
(Authy, Google Authenticator, 1Password, Bitwarden, etc.) and enter a
6-digit code to complete enrollment. Subsequent logins prompt for the
code after the password.

If an admin loses their authenticator, an operator with AWS access can
reset their MFA enrollment so they can re-enroll on next login:

```bash
aws cognito-idp admin-set-user-mfa-preference \
  --user-pool-id "$POOL" \
  --username "user@example.com" \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false
```

### 8. Build + deploy the SPA

The SPA reads its config at build time from `web/.env.production`:

```bash
cd web
cp .env.example .env.production

# Fill in from CloudFormation outputs:
aws cloudformation describe-stacks --stack-name AntsDispatch-Dev-Auth --region us-east-1 \
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

1. **Stack name prefix.** `AntsDispatch-Dev-*` vs `AntsDispatch-Prod-*` — each
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
VITE_APP_BRAND=Acme          # → "Acme Dispatch", collapsed mark "A•"
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

This project is **dual-licensed by component**:

- **Backend, infrastructure, shared packages, and tooling** (`infra/`,
  `services/`, `packages/`, `scripts/`, root `deploy.sh`, root `package.json`)
  — released under the **MIT License**. See [`LICENSE`](./LICENSE).
- **Compiled web SPA bundle** (the output of `npm run build` in `web/` —
  i.e. `web/dist/`) — distributed under the **GNU General Public License,
  version 2 or later (GPL-2.0-or-later)**, because that bundle statically
  links TinyMCE 7, which is GPL-2.0-or-later. See
  [`LICENSE.gpl-2.0`](./LICENSE.gpl-2.0).

The individual source files under `web/src/` remain **MIT** in this
repository (anyone may take a file and reuse it under MIT). Only the
combined production bundle picks up the GPL-2 obligation, because that's
where TinyMCE's compiled code lives alongside ours.

If you redistribute the compiled SPA — for example by hosting it for
end users or shipping it inside another product — GPL-2 requires that
you either bundle the corresponding source code with it or offer a
written promise to provide the source on request. The source is this
repository.

### Third-party notices

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the per-package
attribution list. The licensing-significant dependencies are:

- **TinyMCE 7** — GPL-2.0-or-later (Tiny Technologies, Inc.). Bundled into
  the production SPA at build time.
- React, TanStack Router/Query, AWS SDK v3, AWS CDK v2, Zod, Vite, etc.
  — MIT or Apache-2.0.
- Source Serif 4, Inter, JetBrains Mono via Google Fonts — SIL Open Font
  License 1.1.

Regenerate the full attribution list with
`npx license-checker --production --summary` from the repo root.
