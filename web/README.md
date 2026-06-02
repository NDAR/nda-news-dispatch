# @ants-dispatch/web — admin SPA

Vite + React 18 + TypeScript + TanStack Router/Query + Jodit WYSIWYG, with
hand-rolled Cognito Hosted UI PKCE auth. Served from the S3 `spa` bucket via
CloudFront in prod; `npm run dev` for local development.

## First-run

1. **Copy `.env.example` → `.env.local`** and fill with values from the
   deployed stack outputs:
   ```bash
   aws cloudformation describe-stacks --stack-name AntsDispatch-Dev-Auth --region us-east-1 \
     --query 'Stacks[0].Outputs' --output table
   aws cloudformation describe-stacks --stack-name AntsDispatch-Dev-Api  --region us-east-1 \
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

The repo-root **`./deploy.sh`** wraps build + S3 sync + CloudFront
invalidation. From the project root:

```bash
./deploy.sh dev               # build, sync, invalidate
./deploy.sh dev --skip-build  # reuse existing web/dist
./deploy.sh dev --web-only    # SPA only, skip CDK
```

The `web/deploy.sh` helper does the same thing if you cd into `web/` first.

For the manual flow, mirror what `web/deploy.sh` does: resolve stack outputs,
export the required Vite variables, then build.

```bash
AUTH=AntsDispatch-Dev-Auth
EDGE=AntsDispatch-Dev-Edge
REGION=us-east-1

PUBLIC_URL=$(aws cloudformation describe-stacks --stack-name "$EDGE" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`PublicUrl`].OutputValue' --output text)
VITE_API_BASE=
VITE_COGNITO_DOMAIN=$(aws cloudformation describe-stacks --stack-name "$AUTH" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`HostedUiDomain`].OutputValue' --output text)
VITE_COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name "$AUTH" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)
VITE_REDIRECT_URI="${PUBLIC_URL%/}/auth/callback"
export VITE_API_BASE VITE_COGNITO_DOMAIN VITE_COGNITO_CLIENT_ID VITE_REDIRECT_URI

npm run build

# Publish to the SPA bucket + invalidate CloudFront:
SPA=$(aws cloudformation describe-stacks --stack-name AntsDispatch-Dev-Storage --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`SpaBucketName`].OutputValue' --output text)
DIST=$(aws cloudformation describe-stacks --stack-name AntsDispatch-Dev-Edge --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)
aws s3 sync dist/ "s3://$SPA/" --delete \
  --cache-control 'public, max-age=31536000, immutable' --exclude index.html
aws s3 cp dist/index.html "s3://$SPA/index.html" --cache-control 'no-cache, must-revalidate'
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*'
```

`VITE_API_BASE=""` in prod makes the SPA use same-origin CloudFront routing
(`/admin/*`, `/public/*` → API Gateway), so no CORS headaches.

## Brand

The sidebar, browser tab title, and collapsed-sidebar mark all read from a
single brand prefix. "Dispatch" is fixed; only the prefix is configurable.

```
VITE_APP_BRAND=Ants     # → "Ants Dispatch", collapsed mark "A•"
```

Defaults to `Ants` if unset. Rebuild + redeploy to apply.

## Routes

All `/*` routes live under the authenticated `_app` parent route (which
gates on a valid Cognito session and renders the sidebar via `AppShell`).
The unauthenticated `/auth/callback` runs the PKCE code exchange.

| Route                        | Backed by | Purpose |
|------------------------------|-----------|---------|
| `/compose`                   | `/admin/templates` (CRUD), `/admin/types`, `/admin/assets`, `/admin/templates/{id}/test-send` | Per-newsletter editor with Jodit (Visual / HTML modes), live preview iframe, asset picker, debounced autosave, "Send to yourself" test send, "Preview rendered email" modal, resizable HTML/preview split. |
| `/types`, `/types/$typeId`   | `/admin/types` | List + edit page for newsletter types, including a default HTML body that seeds new newsletters of that type. |
| `/subscribers`               | `/admin/contacts`, `/admin/imports`, `/admin/suppressions` | Subscriber table, CSV import, single-contact create, suppressions panel. |
| `/send`                      | `/admin/audience/preview`, `/admin/campaigns`, `POST /admin/campaigns/{id}/send` | Three-step send wizard (recipients, timing, review). Hands off to `worker-enqueue` via the campaign send API. |
| `/history`                   | `/admin/campaigns?status=…` | Sortable list of campaigns with delivery / open-rate / CTR / unsubscribe stats; clickable metric cards open a per-metric trend modal. |
| `/history/$campaignId`       | `/admin/campaigns/{id}`, `/admin/campaigns/{id}/recipients`, `/admin/campaigns/{id}/links` | Detail page: aggregate metrics, engagement-over-time chart, per-recipient table with bounce / opened / clicked filters, top-links card with Total / Unique / % of total columns. |
| `/settings`                  | `/admin/settings` | Org-level email footer (Jodit), sender name + address, live preview iframe. Footer + sender info are auto-appended on every send. |
| `/help`                      | — | Static walkthrough of every page; sticky TOC sidebar. |
| `/auth/callback`             | Cognito Hosted UI | PKCE code exchange. |

## Notes

- `src/routeTree.gen.ts` is auto-generated by TanStack Router on `npm run dev`
  / `npm run build`. Don't edit it by hand.
- `src/lib/previewFrame.ts` and `src/lib/footerPreview.ts` mirror the
  worker-send footer renderer so Compose / Send / Settings preview modals
  render identically to a real send.
- The `useSettings` query is cached at the React-Query layer; the Compose
  preview modal also pulls it so the rendered footer matches what would
  actually be sent.
