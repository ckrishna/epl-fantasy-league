#!/bin/bash
set -e

API_ID=3in32oonc3
REGION=us-west-2
ACCOUNT_ID=564103198625
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:stats-api"
PARENT_ID=zl4cpx   # /stats

# 1. Create the /stats/feedback resource
RESOURCE_ID=$(aws apigateway create-resource \
  --rest-api-id $API_ID \
  --parent-id $PARENT_ID \
  --path-part feedback \
  --region $REGION \
  --query 'id' --output text)
echo "Created resource: $RESOURCE_ID"

# 2. POST method -> stats-api Lambda (AWS_PROXY, same as /stats/query)
aws apigateway put-method \
  --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method POST --authorization-type NONE --region $REGION

aws apigateway put-method-response \
  --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method POST --status-code 200 \
  --response-parameters '{"method.response.header.Access-Control-Allow-Origin": false}' \
  --response-models '{"application/json": "Empty"}' \
  --region $REGION

aws apigateway put-integration \
  --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method POST --type AWS_PROXY --integration-http-method POST \
  --uri "arn:aws:apigateway:$REGION:lambda:path/2015-03-31/functions/$LAMBDA_ARN/invocations" \
  --region $REGION

# 3. OPTIONS method for CORS preflight (MOCK integration, mirrored from /stats/query)
aws apigateway put-method \
  --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method OPTIONS --authorization-type NONE --region $REGION

aws apigateway put-method-response \
  --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method OPTIONS --status-code 200 \
  --response-parameters '{"method.response.header.Access-Control-Allow-Headers": false, "method.response.header.Access-Control-Allow-Methods": false, "method.response.header.Access-Control-Allow-Origin": false}' \
  --response-models '{"application/json": "Empty"}' \
  --region $REGION

aws apigateway put-integration \
  --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method OPTIONS --type MOCK \
  --request-templates '{"application/json": "{\"statusCode\": 200}"}' \
  --region $REGION

cat > /tmp/feedback-options-integration-response.json <<'EOF'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
  "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,POST'",
  "method.response.header.Access-Control-Allow-Origin": "'*'"
}
EOF

aws apigateway put-integration-response \
  --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method OPTIONS --status-code 200 \
  --response-parameters file:///tmp/feedback-options-integration-response.json \
  --region $REGION

# 4. Let API Gateway invoke the Lambda for this new route (harmless if a broader
#    permission already covers it -- you'll just see ResourceConflictException, ignore it)
aws lambda add-permission \
  --function-name stats-api \
  --statement-id apigateway-stats-feedback \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/POST/stats/feedback" \
  --region $REGION || echo "(permission already exists, that's fine)"

# 5. Deploy -- resource/method changes don't go live until deployed to the stage
aws apigateway create-deployment \
  --rest-api-id $API_ID \
  --stage-name prod \
  --region $REGION

echo "Done. /stats/feedback should be live now."
