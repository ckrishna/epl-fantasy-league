#!/bin/bash
set -e

# Zips index.mjs + production dependencies and pushes them to the live
# fpl-data-ingester Lambda. This function has no CI/CD -- deploy is always this
# manual step, run by hand after merging a change. Standardizes on ONE zip name/path
# (previously this dir had three stray, inconsistently-named zips left over from ad-hoc
# manual deploys: fpl-data-ingester-deploy.zip, function.zip, lambda.zip -- all
# gitignored, all just local build artifacts, easy to lose track of which one is
# current). This script always rebuilds fpl-data-ingester-deploy.zip fresh from
# scratch, so there's never ambiguity about whether the zip matches the working tree.
#
# Run from anywhere; cd's internally. Requires AWS credentials in the environment
# already configured for the account this project deploys to (same one used by
# scripts/automate_fpl_*.sh at the repo root).

REGION=us-west-2
FUNCTION_NAME=fpl-data-ingester

cd "$(dirname "$0")/.."   # lambda/fpl-data-ingester/

echo "Installing production dependencies..."
npm install --omit=dev

echo "Building deploy package..."
rm -f fpl-data-ingester-deploy.zip
zip -rq fpl-data-ingester-deploy.zip index.mjs node_modules package.json

echo "Uploading to $FUNCTION_NAME ($REGION)..."
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb://fpl-data-ingester-deploy.zip \
  --region "$REGION"

echo ""
echo "Deployed. Verify with:"
echo "  aws lambda invoke --function-name $FUNCTION_NAME --payload '{}' --cli-binary-format raw-in-base64-out /tmp/out.json --region $REGION && cat /tmp/out.json"
echo "or check the latest ingestion_runs row's summary.mode field to confirm the new code actually ran."
