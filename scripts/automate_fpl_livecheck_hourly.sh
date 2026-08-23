#!/bin/bash
set -e

REGION=us-west-2
ACCOUNT_ID=564103198625
RULE_NAME=fpl-livecheck-hourly
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:fpl-data-ingester"

# 1. Create the schedule -- top of every hour, every day. Safe to run this often
#    because the handler's own gate (getTodaysFixtureWindow in index.mjs) bails out
#    before any FPL API call unless "now" falls inside today's actual fixture window
#    (earliest kickoff today + 30min, through latest kickoff today + 4h). Most of
#    these 24 invocations/day will be a no-op DynamoDB Scan against our own
#    fpl_fixture_data and nothing else.
aws events put-rule \
  --name $RULE_NAME \
  --schedule-expression "cron(0 * * * ? *)" \
  --state ENABLED \
  --region $REGION

# 2. Point it at fpl-data-ingester, WITH a custom Input JSON. Two things load-bearing:
#      - "mode": "live-check" -- tells the handler to run getTodaysFixtureWindow()
#        first and skip the whole run if we're outside today's fixture window.
#      - "source": "aws.events" -- a custom Input completely REPLACES the event
#        EventBridge would otherwise send (source included), so without this the
#        handler's trigger-detection would misreport every one of these runs as
#        "manual" in ingestion_runs instead of "scheduled". See the comment on
#        recordIngestionRun in lambda/fpl-data-ingester/index.mjs.
#    Using a JSON file rather than the inline --targets shorthand: the AWS CLI's
#    shorthand parser trips over the nested double quotes in the Input value
#    ("Expected: '=', received: '"'") on some CLI versions, regardless of shell.
TARGETS_FILE=$(mktemp)
cat > "$TARGETS_FILE" <<JSON
[
  {
    "Id": "1",
    "Arn": "$LAMBDA_ARN",
    "Input": "{\"mode\":\"live-check\",\"source\":\"aws.events\"}"
  }
]
JSON

aws events put-targets \
  --rule $RULE_NAME \
  --targets "file://$TARGETS_FILE" \
  --region $REGION

rm -f "$TARGETS_FILE"

# 3. Let EventBridge invoke it. Lambda resource policies scope permissions per source
#    rule ARN, so even though fpl-data-ingester already has a permission statement for
#    its existing nightly rule, this NEW rule needs its own statement -- a distinct
#    --statement-id, harmless if it somehow already exists.
aws lambda add-permission \
  --function-name fpl-data-ingester \
  --statement-id AllowEventBridgeInvokeLiveCheck \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:$REGION:$ACCOUNT_ID:rule/$RULE_NAME" \
  --region $REGION || echo "(permission already exists, that's fine)"
