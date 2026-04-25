# infra — AWS CDK

## Stacks

- `NdaDispatch-<env>-Auth` — Cognito User Pool + hosted UI domain + SPA client (auth code flow, PKCE, 12-char password policy, optional TOTP MFA).
- `NdaDispatch-<env>-Storage` — S3 buckets: `spa` (SPA assets) and `archive` (rendered HTML + previews).
- `NdaDispatch-<env>-Edge` — CloudFront distribution + ACM cert for the configured `domain`. Single origin fronting: `/` → SPA bucket, `/archive/*` + `/renders/*` → archive bucket, `/admin/*` + `/public/*` → API Gateway. Cert uses DNS validation (no Route 53 dependency).
- `NdaDispatch-<env>-Data` — DynamoDB single table (`nda-dispatch-<env>`) with GSI1, streams, PITR, TTL; SQS `import` and `send` queues (+ DLQs). See `docs/data-model.md`.
- `NdaDispatch-<env>-Processing` — S3 `imports/*.csv` PUT → SQS `import` → `worker-import` Lambda. Parses CSV (quote-aware), checks suppressions, upserts contacts + tag index items, updates the `IMPORT#<id>` record with counts and status.
- `NdaDispatch-<env>-Delivery` — SES domain identity `dispatch.scienthouse.io` (DKIM on, custom MAIL-FROM `mail.dispatch.scienthouse.io`), configuration set with reputation metrics + event destination → SNS topic `ses-events`. `worker-send` Lambda consumes SQS `send`, calls `SESv2:SendEmail` with List-Unsubscribe headers + per-recipient HMAC tokens, updates `RCPT#<email>` rows. Domain identity stays "pending verification" until DNS is wired (DKIM CNAMEs + `_amazonses` TXT).
- `NdaDispatch-<env>-Events` — SNS `ses-events` → `worker-events` Lambda → Dynamo. Dispatches Send/Delivery/Bounce/Complaint/Open/Click/Reject/DeliveryDelay/RenderingFailure/Subscription into `STATS` ADD counters + `RCPT#<email>` timestamps + state. Permanent bounces and complaints write a `SUPP#<email>` suppression. Failures land in a dedicated `events-dlq`.
- `NdaDispatch-<env>-Api` — Regional API Gateway REST API fronted by AWSv2 WAF (Common + KnownBadInputs managed rule groups, IP rate-limit scoped to `/public/*`). Routes:
  - Admin (Cognito JWT required): `GET /admin/ping`, `GET|POST /admin/templates` + `{id}`, `GET|POST /admin/contacts` + `{email}`, `GET|POST /admin/imports` + `{id}`, `GET|POST /admin/campaigns` + `{id}` + `{id}/send`, `GET|POST /admin/suppressions` + `{email}`.
  - Public (unauthenticated): `GET|POST /public/u` — HMAC-signed unsubscribe; GET returns a styled confirmation page, POST fulfills RFC 8058 one-click unsubscribe.

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

The repo commits `domain.dev` + `domain.prod` in `infra/cdk.json` so routine
deploys don't need any flags. Change that file (or pass `-c domain=…`) to
point at a different hostname — no code change needed.

Other optional context keys: `rootDomain` (inferred from `domain` if unset),
`region` (default `us-east-1`), `mailFromSubdomain` (default `mail`, yielding
`mail.<domain>`).

## Deploy

**Run these from `infra/`** (so `cdk.json` is picked up):

```bash
cd infra
npm run synth
npm run deploy:dev   # uses context domain.dev
npm run deploy:prod  # uses context domain.prod

# Ad-hoc override without touching cdk.json:
npx cdk deploy --all -c env=dev -c domain=staging.example.com
```

Or from the repo root, use the `--prefix` passthrough:

```bash
npm run deploy:dev   # same as above
```

If you see `--app is required either in command-line, in cdk.json or in ~/.cdk.json`,
you're running `cdk` from a directory that has no `cdk.json` — `cd infra` first, or
use the root-level npm scripts above.

Outputs printed after a successful deploy:

- `UserPoolId`, `UserPoolClientId`, `HostedUiDomain`, `Issuer`
- `ApiUrl`

## Smoke test

Create the first admin (no self-signup), set a password, then:

```bash
TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id <id> \
  --client-id <client> --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@nimh.nih.gov,PASSWORD='…' \
  --query 'AuthenticationResult.IdToken' --output text)

curl -H "Authorization: $TOKEN" "$API_URL/admin/ping"
# → { "ok": true, "env": "dev", "user": { "sub": "...", "email": "..." } }
```

## Uploading the SPA

```bash
aws s3 sync web/ s3://$(aws cloudformation describe-stacks \
  --stack-name NdaDispatch-Dev-Storage \
  --query 'Stacks[0].Outputs[?OutputKey==`SpaBucketName`].OutputValue' --output text)/ \
  --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'
```

Then open `https://<DistributionDomain>/` (output of the storage stack).

## curl smoke test (templates)

```bash
ID_TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id <pool> \
  --client-id <client> --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@nimh.nih.gov,PASSWORD='…' \
  --query 'AuthenticationResult.IdToken' --output text)
API=$(aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Api \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)

# create
curl -sS -X POST "$API/admin/templates" \
  -H "Authorization: $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"May dispatch","subject":"Hello","html":"<h1>Hi</h1>","targetTags":["researcher"]}'

# list
curl -sS -H "Authorization: $ID_TOKEN" "$API/admin/templates"

# update (new version)
curl -sS -X PUT "$API/admin/templates/<id>" \
  -H "Authorization: $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"May dispatch","subject":"Hello v2","html":"<h1>Hi v2</h1>"}'
```

Rendered HTML is viewable at `https://<DistributionDomain>/renders/<id>/v<version>.html`.

## curl smoke test (contacts + CSV import)

```bash
# single contact
curl -sS -X POST "$API/admin/contacts" \
  -H "Authorization: $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"mira.okafor@chop.edu","name":"Mira Okafor","org":"CHOP","tags":["researcher"]}'

# list by tag
curl -sS -H "Authorization: $ID_TOKEN" "$API/admin/contacts?tag=researcher"

# CSV import — request a presigned upload URL, PUT the CSV, poll for status
CREATE=$(curl -sS -X POST "$API/admin/imports" \
  -H "Authorization: $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"filename":"sample.csv","assignTag":"new"}')
IMPORT_ID=$(echo "$CREATE" | jq -r .importId)
UPLOAD=$(echo "$CREATE" | jq -r .uploadUrl)

printf 'email,name,org\njay@brown.edu,Jay Rao,Brown\n' \
  | curl -sS -X PUT -H 'content-type: text/csv' --data-binary @- "$UPLOAD"

# worker fires on the S3 PUT — poll until status=done
curl -sS -H "Authorization: $ID_TOKEN" "$API/admin/imports/$IMPORT_ID"
```

## curl smoke test (campaigns + send)

```bash
# create a campaign from a template
CAMP=$(curl -sS -X POST "$API/admin/campaigns" \
  -H "Authorization: $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Smoke test","templateId":"<template-id>"}')
CAMP_ID=$(echo "$CAMP" | jq -r .id)

# send to contacts tagged "researcher" but NOT "international"
curl -sS -X POST "$API/admin/campaigns/$CAMP_ID/send" \
  -H "Authorization: $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"tagMode":"all","tags":["researcher"],"excludeTags":["international"]}'

# campaign row now status=queued; RCPT rows written; worker-send fires per message
curl -sS -H "Authorization: $ID_TOKEN" "$API/admin/campaigns/$CAMP_ID"
```

## SES DNS records (needed to actually send)

After the Delivery stack deploys, the SES console shows pending DKIM tokens
under "Verified identities → dispatch.scienthouse.io". Publish these at the NIMHDA
DNS once you're ready:

- 3 × CNAME for DKIM: `<token>._domainkey.dispatch.scienthouse.io` → `<token>.dkim.amazonses.com`
- 1 × TXT for SPF on the MAIL-FROM subdomain: `mail.dispatch.scienthouse.io` → `v=spf1 include:amazonses.com -all`
- 1 × MX for MAIL-FROM: `mail.dispatch.scienthouse.io` → `10 feedback-smtp.us-east-1.amazonses.com`
- 1 × TXT for DMARC: `_dmarc.dispatch.scienthouse.io` → `v=DMARC1; p=none`
  (the `rua=mailto:…` reporting address is optional — add one later, e.g. via a free aggregator like dmarcian / Postmark, once you want aggregate reports)

Until verification succeeds and SES production access is granted, sends will
fail with `MessageRejected`. Workflow can still be exercised end-to-end by
verifying individual test recipients in the SES sandbox.

## Note on open/click tracking

SES's Configuration Set handles open pixels and click redirects automatically.
Links in outgoing HTML are rewritten to the SES tracking domain (default
`r.us-east-1.awstrack.me`), and the resulting Open / Click events flow through
SNS → `worker-events` → Dynamo, so we don't need our own `/public/o` or
`/public/c` endpoints. Replace the tracking domain with `track.dispatch.scienthouse.io`
once DNS is wired by setting `trackingOptions.customRedirectDomain` on the
configuration set.

## Walkthrough: pointing dispatch.scienthouse.io at the stack

The `EdgeStack` creates the ACM cert + CloudFront alias + path-based routing.
It needs your DNS in two places.

### 1. Kick off the deploy — it'll pause waiting on cert validation

```bash
cd infra
npm run deploy:dev
```

When it reaches the `*-Edge` stack, it creates the ACM certificate and then
**blocks** on `CertificateValidation`. CloudFormation is waiting for you to
publish one DNS record that proves you own the domain. The deploy will time
out after ~90 minutes if you don't add it.

### 2. Grab the ACM validation CNAME

In a second terminal, while the deploy is paused:

```bash
CERT_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query "StackResources[?LogicalResourceId=='CertE7D9FC49'].PhysicalResourceId" \
  --output text)

aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

You'll see something like:
```json
{
  "Name":  "_abc123.dispatch.scienthouse.io.",
  "Type":  "CNAME",
  "Value": "_xyz789.acm-validations.aws."
}
```

Publish that as a CNAME at your DNS provider. Within ~2 min CloudFormation
sees the validation succeed and the stack continues creating the CloudFront
distribution.

### 3. Wait for CloudFront to deploy (~5–10 min)

Once the stack finishes, grab the distribution's target hostname:

```bash
aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionDomain`].OutputValue' --output text
# e.g. d1a2b3c4.cloudfront.net
```

### 4. Publish the alias CNAME

At your DNS provider for `scienthouse.io`, add:

| Type  | Name       | Value                    | TTL |
|-------|------------|--------------------------|-----|
| CNAME | `dispatch` | `d1a2b3c4.cloudfront.net`| 300 |

DNS propagation is usually instant; worst case 5 min.

### 5. Verify

```bash
curl -sI https://dispatch.scienthouse.io/                    # → 200, SPA HTML
curl -sI https://dispatch.scienthouse.io/admin/ping          # → 401 (auth required, proves API Gateway is behind CloudFront)
curl -sI "https://dispatch.scienthouse.io/public/u?c=x&e=x@y.z&t=z"  # → 400 (invalid token, proves public route works)
```

Once this works, update Cognito's SPA client callback URL in the console (or
update `lib/auth-stack.ts`) to `https://dispatch.scienthouse.io/auth/callback`
and run `npm run deploy:dev` again.

## Not yet wired (tracked for step 8)

- SPA port to Vite + React + TanStack Router; views wired to the admin API
- CI/CD (GitHub Actions → CDK deploy, SPA build → S3 + CloudFront invalidation)
