#!/usr/bin/env bash
# One-off setup script: creates the /manager-squad API Gateway resource for the new
# "click a manager in Standings" squad view (handleManagerSquad in
# handlers/manager-squad.mjs, routed in index.mjs). Same GET + MOCK-OPTIONS/CORS
# pattern as every other route in this API -- see add-missing-api-routes.sh, which
# this is a trimmed copy of for a single new resource.
#
# Usage: bash add-manager-squad-route.sh
# Requires: aws CLI configured with the credentials you've already been using for
# `aws lambda update-function-code`. Safe to re-run -- create-resource is skipped if
# the resource already exists, and put-method/put-method-response are skipped if
# already present (both throw ConflictException on a second call, unlike
# put-integration which genuinely overwrites in place).

set -euo pipefail

API_ID="3in32oonc3"
REGION="us-west-2"
ROOT_ID="dnvxi1ld6l"
LAMBDA_URI="arn:aws:apigateway:us-west-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-west-2:564103198625:function:stats-api/invocations"
CORS_HEADERS="'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"

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

method_exists() {
  aws apigateway get-method --rest-api-id "$API_ID" --region "$REGION" \
    --resource-id "$1" --http-method "$2" >/dev/null 2>&1
}

method_response_exists() {
  aws apigateway get-method-response --rest-api-id "$API_ID" --region "$REGION" \
    --resource-id "$1" --http-method "$2" --status-code "$3" >/dev/null 2>&1
}

add_route() {
  local resource_id="$1"
  local http_method="$2"

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

echo "Creating /manager-squad..."
MANAGER_SQUAD_ID=$(get_or_create_resource "$ROOT_ID" manager-squad /manager-squad)
add_route "$MANAGER_SQUAD_ID" GET

echo "Deploying to prod stage..."
aws apigateway create-deployment \
  --rest-api-id "$API_ID" --region "$REGION" \
  --stage-name prod \
  --description "Add /manager-squad"

echo "Done. Verify with:"
echo "  curl -i 'https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod/manager-squad?entry_id=YOUR_ENTRY_ID'"
