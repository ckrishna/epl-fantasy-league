#!/usr/bin/env bash
# One-off setup script: creates the /manager-squad/advisor API Gateway resource for the
# real transfer-suggestion endpoint (handleSquadAdvisor in handlers/manager-squad.mjs,
# routed in index.mjs ahead of the plain /manager-squad match). Trimmed copy of
# add-manager-squad-route.sh's own pattern -- see that script's header comment for the
# full rationale (same GET + MOCK-OPTIONS/CORS shape as every route in this API).
#
# Unlike add-manager-squad-route.sh, this resource is a CHILD of /manager-squad, not a
# root-level resource -- get_or_create_resource below looks up /manager-squad's own
# resource id first and creates "advisor" underneath it, so the final path is
# /manager-squad/advisor (matching index.mjs's path.includes('/manager-squad/advisor')
# check, which is deliberately ordered before the plainer '/manager-squad' check).
#
# Usage: bash add-squad-advisor-route.sh
# Requires: aws CLI configured with the credentials you've already been using for
# `aws lambda update-function-code`. Safe to re-run -- same idempotency as
# add-manager-squad-route.sh (create-resource/put-method/put-method-response are all
# skipped if already present).

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

echo "Looking up /manager-squad (parent resource)..."
MANAGER_SQUAD_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" \
  --query "items[?path=='/manager-squad'].id | [0]" --output text)
if [ -z "$MANAGER_SQUAD_ID" ] || [ "$MANAGER_SQUAD_ID" == "None" ]; then
  echo "ERROR: /manager-squad resource not found -- run add-manager-squad-route.sh first." >&2
  exit 1
fi

echo "Creating /manager-squad/advisor..."
ADVISOR_ID=$(get_or_create_resource "$MANAGER_SQUAD_ID" advisor /manager-squad/advisor)
add_route "$ADVISOR_ID" GET

echo "Deploying to prod stage..."
aws apigateway create-deployment \
  --rest-api-id "$API_ID" --region "$REGION" \
  --stage-name prod \
  --description "Add /manager-squad/advisor"

echo "Done. Verify with:"
echo "  curl -i 'https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod/manager-squad/advisor?entry_id=YOUR_ENTRY_ID'"
