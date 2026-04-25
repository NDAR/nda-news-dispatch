# @nda-dispatch/web — admin SPA

Vite + React + TypeScript + TanStack Router/Query, hand-rolled Cognito
Hosted UI PKCE auth. Served from the S3 `spa` bucket via CloudFront in prod;
`npm run dev` for local development.

## First-run

1. **Copy `.env.example` → `.env.local`** and fill with values from the
   deployed stack outputs:
   ```bash
   aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Auth --region us-east-1 \
     --query 'Stacks[0].Outputs' --output table
   aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Api  --region us-east-1 \
     --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text
   ```
   Map the outputs:
   - `HostedUiDomain` → `VITE_COGNITO_DOMAIN`
   - `UserPoolClientId` → `VITE_COGNITO_CLIENT_ID`
   - `ApiUrl` (e.g. `https://xxx.execute-api.us-east-1.amazonaws.com/dev/`, strip trailing slash) → `VITE_API_BASE`

2. **Install + run:**
   ```bash
   cd web
   npm install
   npm run dev
   # → http://localhost:5173
   ```

   First load redirects to Cognito Hosted UI. Sign in with the admin user you
   created via `admin-create-user`. On return you'll land on `/compose`.

## Production build & deploy

```bash
# Build a static bundle — inline the prod env:
cat > .env.production <<EOF
VITE_API_BASE=
VITE_COGNITO_DOMAIN=<HostedUiDomain>
VITE_COGNITO_CLIENT_ID=<UserPoolClientId>
VITE_REDIRECT_URI=https://dispatch.scienthouse.io/auth/callback
EOF
npm run build

# Publish to the SPA bucket + invalidate CloudFront:
SPA=$(aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Storage --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`SpaBucketName`].OutputValue' --output text)
DIST=$(aws cloudformation describe-stacks --stack-name NdaDispatch-Dev-Edge --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)
aws s3 sync dist/ "s3://$SPA/" --delete
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*'
```

Note: `VITE_API_BASE=""` in prod makes the SPA use the same-origin CloudFront
routing (`/admin/*`, `/public/*` → API Gateway), so no CORS headaches in prod.

## What's wired

| Route             | Endpoint(s)                                             | Status |
|-------------------|---------------------------------------------------------|--------|
| `/compose`        | `GET/POST/PUT/DELETE /admin/templates`                  | ✓      |
| `/subscribers`    | `GET/DELETE /admin/contacts`, `POST /admin/imports`     | ✓      |
| `/send`           | `POST /admin/campaigns` + `POST .../send`               | ✓      |
| `/history`        | `GET /admin/campaigns?status=…`                         | ✓      |
| `/auth/callback`  | Cognito Hosted UI PKCE code exchange                    | ✓      |

## Known gaps (future work)

- No inline tag editor on the subscribers table (single-import tag assign works)
- History drill-down chart (per-campaign opens-over-time series) not yet wired — needs a new `GET /admin/campaigns/{id}/timeseries` endpoint
- Send preview ("send test to yourself") still not wired — backend endpoint TBD
- Suppressions UI missing
- TanStack Router generates `src/routeTree.gen.ts` on first build; don't edit manually
