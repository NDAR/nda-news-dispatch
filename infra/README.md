# infra — AWS CDK

CDK v2 (TypeScript). Eight stacks per env. Deploys to `us-east-1` by default,
configurable via `-c region=…`.

## Stacks

| Stack | Purpose |
|---|---|
| `NdaDispatch-<env>-Auth` | Cognito User Pool + Hosted UI domain + SPA app client (auth code flow + PKCE, 12-char password policy, required TOTP MFA in prod (off in dev), SMS disabled). |
| `NdaDispatch-<env>-Storage` | S3 buckets: `spa` (static SPA bundle), `archive` (rendered HTML + uploaded asset images). |
| `NdaDispatch-<env>-Data` | DynamoDB single table (`nda-dispatch-<env>`) with GSI1 + GSI2, streams, PITR, TTL. SQS `send` queue (per-recipient SES jobs) + DLQ. SQS `enqueue` queue (one-message-per-campaign fan-out trigger) + DLQ. `unsubscribeSecret` in Secrets Manager (HMAC key for unsubscribe + view-in-browser tokens). |
| `NdaDispatch-<env>-Processing` | S3 `imports/*.csv` PUT → SQS `import` → `worker-import` Lambda. Parses CSV (quote-aware), checks suppressions, upserts contacts + tag index items, updates the `IMPORT#<id>` record with counts and status. |
| `NdaDispatch-<env>-Delivery` | SES domain identity (DKIM on, custom MAIL-FROM `mail.<domain>`), configuration set with reputation metrics + event destination → SNS `ses-events`. **`worker-send`** consumes the `send` SQS queue and calls `SESv2:SendEmail` with `List-Unsubscribe` headers + per-recipient HMAC tokens, prepends a "View in browser" bar, and re-uses module-cached campaign META + org settings. **`worker-enqueue`** (15-min timeout, batchSize 1) consumes the `enqueue` queue: materializes the audience, writes RCPT rows in 25-row DDB batches, and pushes per-recipient `{campaignId, email}` messages into the `send` queue. Domain identity stays "pending verification" until DNS is wired (DKIM CNAMEs + `_amazonses` TXT). |
| `NdaDispatch-<env>-Events` | SNS `ses-events` → `worker-events` Lambda → DDB. Dispatches Send / Delivery / Bounce / Complaint / Open / Click / Reject / DeliveryDelay / RenderingFailure / Subscription into the `STATS` row (`ADD` counters), the `RCPT#<email>` row (timestamps + state + `clickedLinks` String Set), and per-link `LINK#<hash>` rows (`clicks` and `uniqueClicks` per URL). Permanent bounces and complaints write a `SUPP#<email>` suppression. Failures land in `events-dlq`. |
| `NdaDispatch-<env>-Api` | Regional API Gateway REST API + AWS WAF v2 (Common + KnownBadInputs managed rules, IP rate-limit scoped to `/public/*`). Authentication via Cognito JWT authorizer for everything under `/admin/*`. |
| `NdaDispatch-<env>-Edge` | CloudFront distribution + ACM cert (DNS-validated) for the configured `domain`. Single origin fronting `/` → SPA bucket, `/archive/*` + `/renders/*` → archive bucket, `/admin/*` + `/public/*` → API Gateway. |

### API routes (defined in `lib/api-stack.ts`)

**Admin (Cognito JWT required):**

- `GET /admin/ping`
- `GET|POST /admin/templates`, `GET|PUT|DELETE /admin/templates/{id}`, `POST /admin/templates/{id}/test-send`
- `GET|POST /admin/types`, `GET|PUT|DELETE /admin/types/{id}`
- `GET|POST /admin/contacts`, `GET|PATCH|DELETE /admin/contacts/{email}`
- `GET|POST /admin/imports`, `GET /admin/imports/{id}`
- `GET|POST /admin/campaigns`, `GET|DELETE /admin/campaigns/{id}`, `POST /admin/campaigns/{id}/send`, `POST /admin/campaigns/{id}/cancel`, `GET /admin/campaigns/{id}/recipients`, `GET /admin/campaigns/{id}/links`
- `GET /admin/tags`, `POST /admin/audience/preview`
- `GET|POST /admin/assets`, `DELETE /admin/assets/{id}`
- `GET|PUT /admin/settings` (org-level footer, sender name, sender address)
- `GET|POST /admin/suppressions`, `DELETE /admin/suppressions/{email}`

**Public (unauthenticated):**

- `GET|POST /public/u` — HMAC-signed unsubscribe (`UnsubscribeFn`). GET returns a confirmation page; POST fulfills RFC 8058 one-click unsubscribe.
- `GET /public/v` — HMAC-signed view-in-browser (`ViewFn`). Re-renders the campaign HTML body + footer at view time using current org settings; no per-campaign rendered-HTML snapshot.

## One-time

```bash
cd infra
npm install
npx cdk bootstrap aws://<ACCOUNT>/us-east-1
```

## Configuring the domain

The sending / admin hostname is not hard-coded. It's resolved from CDK
context at deploy time, in this order of precedence:

1. CLI flag: `-c domain=dispatch.example.com` (or env-specific `-c domain.dev=…`)
2. `cdk.json` context keys `domain.dev` / `domain.prod` (per-env) or bare `domain`
3. Env var `DISPATCH_DOMAIN`

`infra/cdk.json` ships with `domain.dev` + `domain.prod` so routine deploys
need no flags. Change that file (or pass `-c domain=…`) to deploy to a
different hostname — no code change needed.

Other optional context keys: `rootDomain` (inferred from `domain` if unset),
`region` (default `us-east-1`), `mailFromSubdomain` (default `mail`, yielding
`mail.<domain>`).

## Deploy

Prefer the **repo-root `./deploy.sh`** — it ships infra + SPA in one shot
and supports `--infra-only` / `--web-only` / `--stacks` flags. See the
top-level README for the full list.

For raw CDK invocations, run from `infra/`:

```bash
cd infra
npm run synth
npm run deploy:dev   # uses context domain.dev, --require-approval never
npm run deploy:prod  # uses context domain.prod, --require-approval broadening

# Single stack:
npx cdk deploy NdaDispatch-Dev-Delivery -c env=dev

# Ad-hoc override without touching cdk.json:
npx cdk deploy --all -c env=dev -c domain=staging.example.com
```

If you see `--app is required either in command-line, in cdk.json or in
~/.cdk.json`, you're running `cdk` from a directory that has no `cdk.json` —
`cd infra` first or use the root-level scripts.

Outputs printed after a successful deploy include `UserPoolId`,
`UserPoolClientId`, `HostedUiDomain`, `Issuer`, `ApiUrl`, `SpaBucketName`,
`DistributionId`, `DistributionDomain`, `SendQueueUrl`, `EnqueueQueueUrl`,
`UnsubscribeSecretArn`.

## Smoke test

```bash
TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id <id> \
  --client-id <client> --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@example.com,PASSWORD='…' \
  --query 'AuthenticationResult.IdToken' --output text)

API=$(aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Api \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)

curl -H "Authorization: $TOKEN" "$API/admin/ping"
# → { "ok": true, "env": "dev", "user": { "sub": "...", "email": "..." } }
```

## SPA upload

The repo-root `./deploy.sh` covers this; for the manual flow:

```bash
SPA=$(aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Storage --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`SpaBucketName`].OutputValue' --output text)
DIST=$(aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)

cd web && npm run build
aws s3 sync dist/ "s3://$SPA/" --delete \
  --cache-control 'public, max-age=31536000, immutable' --exclude index.html
aws s3 cp dist/index.html "s3://$SPA/index.html" --cache-control 'no-cache, must-revalidate'
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/index.html' '/'
```

## SES DNS records (needed to actually send)

After the Delivery stack deploys, the SES console shows pending DKIM tokens
under "Verified identities → `<sendingDomain>`". Publish at your DNS:

- 3 × CNAME for DKIM: `<token>._domainkey.<domain>` → `<token>.dkim.amazonses.com`
- 1 × TXT for SPF on the MAIL-FROM subdomain: `mail.<domain>` → `v=spf1 include:amazonses.com -all`
- 1 × MX for MAIL-FROM: `mail.<domain>` → `10 feedback-smtp.us-east-1.amazonses.com`
- 1 × TXT for DMARC: `_dmarc.<domain>` → `v=DMARC1; p=none`
  (`rua=mailto:…` aggregator reporting is optional)

Until DNS verification succeeds and SES production access is granted, sends
fail with `MessageRejected`. The architecture can still be exercised
end-to-end by verifying individual test recipients in the SES sandbox.

## Open / click tracking

SES's Configuration Set handles the open pixel and click redirects
automatically. Links in outgoing HTML are rewritten to the SES tracking
domain (default `r.us-east-1.awstrack.me`); the resulting Open / Click events
flow through SNS → `worker-events` → DDB, so we don't run our own `/public/o`
or `/public/c`. Replace the tracking domain with `track.<domain>` once DNS is
wired by setting `trackingOptions.customRedirectDomain` on the configuration
set.

`worker-events` deduplicates per recipient: it bumps `opened` (every event)
and `uniqueOpened` (only on first open per recipient via a conditional
`attribute_not_exists(openedAt)` update). Same pattern for clicks, plus a
per-URL `LINK#<hash>` row keyed off a SHA-1 of the link.

## Walkthrough: pointing the chosen domain at the stack

The `EdgeStack` creates the ACM cert + CloudFront alias + path-based routing.
It needs your DNS in two places.

### 1. Kick off the deploy — it'll pause waiting on cert validation

```bash
cd infra
npm run deploy:dev
```

When it reaches `*-Edge`, it creates the ACM certificate and **blocks** on
`CertificateValidation`. CloudFormation is waiting for you to publish one DNS
record proving you own the domain. The deploy times out after ~90 minutes if
the record isn't added.

### 2. Grab the ACM validation CNAME

In a second terminal while the deploy is paused:

```bash
CERT_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query "StackResources[?LogicalResourceId=='CertE7D9FC49'].PhysicalResourceId" \
  --output text)

aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Publish the returned `Name` → `Value` as a CNAME at your DNS provider. CDK
resumes within ~2 minutes once the cert validates.

### 3. Wait for CloudFront (~5–10 min) then publish the alias CNAME

```bash
aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionDomain`].OutputValue' --output text
# e.g. d1a2b3c4xxxxxx.cloudfront.net
```

At your DNS provider, add a CNAME for the chosen subdomain pointing at that
CloudFront hostname.

### 4. Verify

```bash
curl -sI https://<your-domain>/                           # 200, SPA HTML
curl -sI https://<your-domain>/admin/ping                 # 401 — auth required, proves API GW is behind CloudFront
curl -sI "https://<your-domain>/public/u?c=x&e=x@y.z&t=z" # 400 — invalid token, proves public route works
curl -sI "https://<your-domain>/public/v?c=x&e=x@y.z&t=z" # 400/403 — same shape for view-in-browser
```

Once this works, ensure the Cognito SPA client callback URL (set in
`lib/auth-stack.ts`) includes `https://<your-domain>/auth/callback` and
re-deploy.
