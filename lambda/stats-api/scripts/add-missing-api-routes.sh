#!/usr/bin/env bash
# One-off setup script: creates API Gateway resources for routes that exist in
# index.mjs's routing logic but were never actually wired up in API Gateway --
# specifically /trends, /trends/managers (new with the Trends tab), and /app-feedback
# (the Help page feedback form, which turns out to have been missing all along too --
# caught while debugging Trends returning 403 MissingAuthenticationTokenException).
#
# Every existing route here (verified via `aws apigateway get-resources --embed
# methods`) follows the same manual pattern: a GET or POST method with AWS_PROXY
# integration pointing at the stats-api Lambda, plus a MOCK OPTIONS method that
# hardcodes the CORS response headers (API Gateway's classic manual-CORS setup, not
# the "Enable CORS" wizard, but functionally the same result). This script replicates
# that pattern exactly for the three missing routes, then deploys the API so the
# changes actually go live -- creating resources alone does nothing until deployed.
#
# Usage: bash add-missing-api-routes.sh
# Requires: aws CLI configured with the credentials you've already been using for
# `aws lambda update-function-code`. Safe to re-run after a partial failure --
# create-resource, put-method, and put-method-response all throw ConflictException on
# an already-existing resource/method/response (confirmed the hard way on the first
# run of this script), so every step below checks for existence first rather than
# assuming "put" means "create-or-update" the way put-integration genuinely does.

set -euo pipefail

API_ID="3in32oonc3"
REGION="us-west-2"
ROOT_ID="dnvxi1ld6l"
LAMBDA_URI="arn:aws:apigateway:us-west-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-west-2:564103198625:function:stats-api/invocations"
# Value as it needs to appear INSIDE the JSON payload below -- a JSON string whose own
# content is single-quote-wrapped (API Gateway's literal-value convention for response
# parameters). Must be interpolated as \"${CORS_HEADERS}\" (with the escaped double
# quotes), not bare -- bare was the bug that broke the first run of this script.
CORS_HEADERS="'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"

# Looks up an existing resource by its full path first, so this script can be re-run
# safely after a partial failure instead of erroring on "resource already exists" --
# create-resource (unlike put-method/put-integration) is NOT idempotent.
get_or_create_resource() {
  local parent_id="$1" path_part="$2" full_path="$3"
  local id
  id=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" \
    --query "items[?path=='${full_path}'].id | [0]" --output text)
  if [ -n "$id" ] && [ "$id" != "None" ]; then
    echo "${full_path} already exists (${id}), reusing." >&2
  else
    id=$(aws apigateway create-resource \
      --rest-api-id "$API_ID" --region "$REGION" \
      --parent-id "$parent_id" --path-part "$path_part" \
      --query id --output text)
  fi
  echo "$id"
}

# Existence guards -- put-method and put-method-response throw ConflictException if
# called twice for the same (resource, method) / (resource, method, status), unlike
# put-integration/put-integration-response which genuinely do overwrite in place.
method_exists() {
  aws apigateway get-method --rest-api-id "$API_ID" --region "$REGION" \
    --resource-id "$1" --http-method "$2" >/dev/null 2>&1
}

method_response_exists() {
  aws apigateway get-method-response --rest-api-id "$API_ID" --region "$REGION" \
    --resource-id "$1" --http-method "$2" --status-code "$3" >/dev/null 2>&1
}

# Adds a GET or POST route (AWS_PROXY to the stats-api Lambda) plus a MOCK OPTIONS
# route (hardcoded CORS response) to an existing resource ID -- the same two-method
# shape every existing route in this API already has. Safe to re-run even if this
# resource was partially wired by an earlier failed run.
add_route() {
  local resource_id="$1"
  local http_method="$2" # GET or POST

  if ! method_exists "$resource_id" "$http_method"; then
    aws apigateway put-method \
      --rest-api-id "$API_ID" --region "$REGION" \
      --resource-id "$resource_id" --http-method "$http_method" \
      --authorization-type NONE
  fi

  if ! method_response_exists "$resource_id" "$http_method" 200; then
    aws apigateway put-method-response \
      --rest-api-id "$API_ID" --region "$REGION" \
      --resource-id "$resource_id" --http-method "$http_method" \
      --status-code 200 \
      --response-parameters '{"method.response.header.Access-Control-Allow-Origin": false}' \
      --response-models '{"application/json": "Empty"}'
  fi

  aws apigateway put-integration \
    --rest-api-id "$API_ID" --region "$REGION" \
    --resource-id "$resource_id" --http-method "$http_method" \
    --type AWS_PROXY --integration-http-method POST \
    --uri "$LAMBDA_URI" \
    --passthrough-behavior WHEN_NO_MATCH \
    --content-handling CONVERT_TO_TEXT \
    --timeout-in-millis 29000

  if ! method_exists "$resource_id" OPTIONS; then
    aws apigateway put-method \
      --rest-api-id "$API_ID" --region "$REGION" \
      --resource-id "$resource_id" --http-method OPTIONS \
      --authorization-type NONE
  fi

  if ! method_response_exists "$resource_id" OPTIONS 200; then
    aws apigateway put-method-response \
      --rest-api-id "$API_ID" --region "$REGION" \
      --resource-id "$resource_id" --http-method OPTIONS \
      --status-code 200 \
      --response-parameters '{
        "method.response.header.Access-Control-Allow-Headers": false,
        "method.response.header.Access-Control-Allow-Methods": false,
        "method.response.header.Access-Control-Allow-Origin": false
      }' \
      --response-models '{"application/json": "Empty"}'
  fi

  aws apigateway put-integration \
    --rest-api-id "$API_ID" --region "$REGION" \
    --resource-id "$resource_id" --http-method OPTIONS \
    --type MOCK \
    --request-templates '{"application/json": "{\"statusCode\": 200}"}' \
    --passthrough-behavior WHEN_NO_MATCH \
    --timeout-in-millis 29000

  aws apigateway put-integration-response \
    --rest-api-id "$API_ID" --region "$REGION" \
    --resource-id "$resource_id" --http-method OPTIONS \
    --status-code 200 \
    --response-parameters "{
      \"method.response.header.Access-Control-Allow-Headers\": \"${CORS_HEADERS}\",
      \"method.response.header.Access-Control-Allow-Methods\": \"'${http_method},OPTIONS'\",
      \"method.response.header.Access-Control-Allow-Origin\": \"'*'\"
    }"

  echo "Wired ${http_method} + OPTIONS on resource ${resource_id}"
}

echo "Creating /trends..."
TRENDS_ID=$(get_or_create_resource "$ROOT_ID" trends /trends)
add_route "$TRENDS_ID" GET

echo "Creating /trends/managers..."
TRENDS_MANAGERS_ID=$(get_or_create_resource "$TRENDS_ID" managers /trends/managers)
add_route "$TRENDS_MANAGERS_ID" GET

echo "Creating /app-feedback..."
APP_FEEDBACK_ID=$(get_or_create_resource "$ROOT_ID" app-feedback /app-feedback)
add_route "$APP_FEEDBACK_ID" POST

echo "Deploying to prod stage..."
aws apigateway create-deployment \
  --rest-api-id "$API_ID" --region "$REGION" \
  --stage-name prod \
  --description "Add /trends, /trends/managers, /app-feedback"

echo "Done. Verify with:"
echo "  curl -i https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod/trends/managers"
echo "  curl -i https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod/app-feedback -X POST -d '{}'"
