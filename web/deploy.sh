#!/usr/bin/env bash
# Build the SPA, sync to S3, and invalidate CloudFront.
# Usage:  ./deploy.sh            # env=dev
#         ./deploy.sh prod       # env=prod
#         ./deploy.sh dev --skip-build   # deploy current dist/ without rebuilding
set -euo pipefail

ENV="${1:-dev}"
SKIP_BUILD=0
for arg in "$@"; do
  [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=1
done

case "$ENV" in
  dev)  STACK_PREFIX="AntsDispatch-Dev" ;;
  prod) STACK_PREFIX="AntsDispatch-Prod" ;;
  *)    echo "Unknown env: $ENV (expected dev|prod)" >&2; exit 1 ;;
esac

REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }

say "Resolving stack outputs ($ENV, $REGION)…"
SPA_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Storage" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`SpaBucketName`].OutputValue' --output text)
DIST_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Edge" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)
PUBLIC_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Edge" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`PublicUrl`].OutputValue' --output text)
COGNITO_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Auth" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`HostedUiDomain`].OutputValue' --output text)
COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Auth" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)

if [[ -z "$SPA_BUCKET" || "$SPA_BUCKET" == "None" ]]; then
  echo "Could not resolve SPA bucket from ${STACK_PREFIX}-Storage." >&2
  exit 1
fi
if [[ -z "$DIST_ID" || "$DIST_ID" == "None" ]]; then
  echo "Could not resolve CloudFront distribution from ${STACK_PREFIX}-Edge." >&2
  exit 1
fi
if [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" == "None" ]]; then
  echo "Could not resolve public URL from ${STACK_PREFIX}-Edge." >&2
  exit 1
fi
if [[ -z "$COGNITO_DOMAIN" || "$COGNITO_DOMAIN" == "None" ]]; then
  echo "Could not resolve Cognito Hosted UI domain from ${STACK_PREFIX}-Auth." >&2
  exit 1
fi
if [[ -z "$COGNITO_CLIENT_ID" || "$COGNITO_CLIENT_ID" == "None" ]]; then
  echo "Could not resolve Cognito client id from ${STACK_PREFIX}-Auth." >&2
  exit 1
fi

say "SPA bucket: $SPA_BUCKET"
say "Distribution: $DIST_ID"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  say "Installing (if needed)…"
  [[ -d node_modules ]] || npm install
  say "Building…"
  VITE_API_BASE="" \
    VITE_COGNITO_DOMAIN="$COGNITO_DOMAIN" \
    VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" \
    VITE_COGNITO_REGION="$REGION" \
    VITE_REDIRECT_URI="${PUBLIC_URL%/}/auth/callback" \
    npm run build
else
  say "Skipping build (using existing dist/)."
fi

if [[ ! -d dist ]]; then
  echo "No dist/ directory found — run without --skip-build first." >&2
  exit 1
fi

say "Syncing dist/ → s3://$SPA_BUCKET/ (with --delete)…"
aws s3 sync dist/ "s3://$SPA_BUCKET/" --delete \
  --cache-control 'public, max-age=31536000, immutable' \
  --exclude 'index.html'
# index.html is deliberately non-immutable so new deploys propagate.
aws s3 cp dist/index.html "s3://$SPA_BUCKET/index.html" \
  --cache-control 'no-cache, must-revalidate'

say "Creating CloudFront invalidation…"
INVAL_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" --paths '/*' \
  --query 'Invalidation.Id' --output text)
say "Invalidation $INVAL_ID created (typically completes in <60s)."

say "Done. Open: $PUBLIC_URL"
