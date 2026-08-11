#!/bin/bash
set -e

REGION=us-west-2
ACCOUNT_ID=564103198625
RULE_NAME=fpl-bootstrap-weekly
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:fpl-bootstrap"

# 1. Create the schedule -- Sundays 02:00 UTC, distinct from the nightly ingester
#    (04:00 UTC daily) and the weekly stats job (Tuesdays 03:00 UTC).
aws events put-rule \
  --name $RULE_NAME \
  --schedule-expression "cron(0 2 ? * SUN *)" \
  --state ENABLED \
  --region $REGION

# 2. Point it at fpl-bootstrap
aws events put-targets \
  --rule $RULE_NAME \
  --targets "Id=1,Arn=$LAMBDA_ARN" \
  --region $REGION

# 3. Let EventBridge invoke it -- same unconditional AllowEventBridgeInvoke pattern
#    already used for fpl-data-ingester (harmless if it already exists)
aws lambda add-permission \
  --function-name fpl-bootstrap \
  --statement-id AllowEventBridgeInvoke \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --region $REGION || echo "(permission already exists, that's fine)"

