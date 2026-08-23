#!/bin/bash
set -e

REGION=us-west-2
ACCOUNT_ID=564103198625
RULE_NAME=fpl-fixtures-daily
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:fpl-global-stats-weekly"

# 1. Create the schedule -- daily 05:00 UTC, an hour after the nightly ingester
#    (04:00 UTC) and distinct from this same Lambda's existing full-run rule
#    (fpl-global-stats-weekly, Tuesdays 03:00 UTC) and fpl-bootstrap-weekly
#    (Sundays 02:00 UTC).
aws events put-rule \
  --name $RULE_NAME \
  --schedule-expression "cron(0 5 * * ? *)" \
  --state ENABLED \
  --region $REGION

# 2. Point it at fpl-global-stats-weekly, WITH a custom Input JSON. Two things this
#    Input must carry, both load-bearing:
#      - "mode": "fixtures-only" -- tells the handler to skip the expensive
#        ~700-player element-summary loop and only refresh fpl_fixture_data.
#      - "source": "aws.events" -- a custom Input completely REPLACES the event
#        EventBridge would otherwise send (source included), so without this the
#        handler's trigger-detection would misreport every one of these runs as
#        "manual" in ingestion_runs instead of "scheduled". See the comment on
#        recordIngestionRun in lambda/fpl-global-stats-weekly/index.mjs.
#    Using a JSON file rather than the inline --targets shorthand: the AWS CLI's
#    shorthand parser trips over the nested double quotes in the Input value
#    ("Expected: '=', received: '"'") on some CLI versions, regardless of shell.
TARGETS_FILE=$(mktemp)
cat > "$TARGETS_FILE" <<JSON
[
  {
    "Id": "1",
    "Arn": "$LAMBDA_ARN",
    "Input": "{\"mode\":\"fixtures-only\",\"source\":\"aws.events\"}"
  }
]
JSON

aws events put-targets \
  --rule $RULE_NAME \
  --targets "file://$TARGETS_FILE" \
  --region $REGION

rm -f "$TARGETS_FILE"

# 3. Let EventBridge invoke it. Lambda resource policies scope permissions per source
#    rule ARN, so even though fpl-global-stats-weekly already has a permission
#    statement for its existing Tuesday rule, this NEW rule needs its own statement --
#    a distinct --statement-id, harmless if it somehow already exists.
aws lambda add-permission \
  --function-name fpl-global-stats-weekly \
  --statement-id AllowEventBridgeInvokeFixturesDaily \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:$REGION:$ACCOUNT_ID:rule/$RULE_NAME" \
  --region $REGION || echo "(permission already exists, that's fine)"
