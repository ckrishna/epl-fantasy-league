#!/usr/bin/env bash
# One-time script: adds a /seasons route to the existing API Gateway REST API,
# replicating the exact GET + OPTIONS setup already used by /standings (resource
# m5kt49), so it shares the same AWS_PROXY integration to the stats-api Lambda and
# the same MOCK-integration CORS preflight pattern.
#
# Confirmed via:
#   aws apigateway get-method / get-integration --resource-id m5kt49 --http-method GET
#   aws apigateway get-method / get-integration --resource-id m5kt49 --http-method OPTIONS
set -euo pipefail

API_ID="3in32oonc3"
ROOT_ID="dnvxi1ld6l"
REGION="us-west-2"
LAMBDA_ARN="arn:aws:apigateway:us-west-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-west-2:564103198625:function:stats-api/invocations"

echo "Creating /seasons resource..."
SEASONS_RESOURCE_ID=$(aws apigateway create-resource \
  --rest-api-id "$API_ID" --parent-id "$ROOT_ID" --path-part seasons \
  --region "$REGION" --query 'id' --output text)
echo "  -> resource id: $SEASONS_RESOURCE_ID"

echo "Setting up GET (AWS_PROXY to stats-api)..."
aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method GET --authorization-type NONE --region "$REGION" >/dev/null

aws apigateway put-method-response --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method GET --status-code 200 \
  --response-parameters method.response.header.Access-Control-Allow-Origin=false \
  --response-models application/json=Empty --region "$REGION" >/dev/null

aws apigateway put-integration --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method GET --type AWS_PROXY --integration-http-method POST \
  --uri "$LAMBDA_ARN" --passthrough-behavior WHEN_NO_MATCH --timeout-in-millis 29000 \
  --region "$REGION" >/dev/null

aws apigateway put-integration-response --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method GET --status-code 200 --region "$REGION" >/dev/null

echo "Setting up OPTIONS (CORS preflight, MOCK integration)..."
aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method OPTIONS --authorization-type NONE --region "$REGION" >/dev/null

aws apigateway put-method-response --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method OPTIONS --status-code 200 \
  --response-parameters method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false \
  --response-models application/json=Empty --region "$REGION" >/dev/null

cat > /tmp/seasons-options-request-templates.json <<'EOF'
{
  "application/json": "{\"statusCode\": 200}"
}
EOF

aws apigateway put-integration --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method OPTIONS --type MOCK \
  --request-templates file:///tmp/seasons-options-request-templates.json \
  --passthrough-behavior WHEN_NO_MATCH --timeout-in-millis 29000 --region "$REGION" >/dev/null

cat > /tmp/seasons-options-integration-response.json <<'EOF'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
  "method.response.header.Access-Control-Allow-Methods": "'GET,OPTIONS'",
  "method.response.header.Access-Control-Allow-Origin": "'*'"
}
EOF

aws apigateway put-integration-response --rest-api-id "$API_ID" --resource-id "$SEASONS_RESOURCE_ID" \
  --http-method OPTIONS --status-code 200 \
  --response-parameters file:///tmp/seasons-options-integration-response.json \
  --region "$REGION" >/dev/null

rm -f /tmp/seasons-options-request-templates.json /tmp/seasons-options-integration-response.json

echo "Deploying to prod stage..."
aws apigateway create-deployment --rest-api-id "$API_ID" --stage-name prod --region "$REGION" >/dev/null

echo ""
echo "Done. Test with:"
echo "  curl -s https://$API_ID.execute-api.$REGION.amazonaws.com/prod/seasons"
