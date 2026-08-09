#!/usr/bin/env bash
# One-time script: closes two more issues found stale during a GitHub issue-list
# review (2026-08-08) -- one confirmed fixed in code, one confirmed shipped visually.
#
# Closing:
#   #38 - GenBI Bedrock model ID is deprecated (legacy access denied) -- fixed in
#         commit 00d16a2 ("GenBI Phase 0: fix deprecated Bedrock model, add daily cost
#         guardrail"). CLAUDE_MODEL_ID in lambda/stats-api/utils/bedrock.mjs is now
#         'us.anthropic.claude-haiku-4-5-20251001-v1:0', not the legacy
#         'anthropic.claude-3-haiku-20240307-v1:0'. Covered by a regression test
#         (genbi-bedrock-model.test.mjs) that asserts the model ID is never the
#         deprecated one.
#   #7  - Redesign Stats page with split-pane AI assistant layout -- shipped. The
#         current Stats page is a two-pane layout: a "League Intelligence" input pane
#         (question box + suggested questions) alongside a "League Analysis" answer
#         pane, matching what this issue asked for.
set -euo pipefail

gh issue close 38 --comment "$(cat <<'EOF'
Fixed in commit 00d16a2 ("GenBI Phase 0: fix deprecated Bedrock model, add daily
cost guardrail"). CLAUDE_MODEL_ID in lambda/stats-api/utils/bedrock.mjs now points
to 'us.anthropic.claude-haiku-4-5-20251001-v1:0', not the legacy
'anthropic.claude-3-haiku-20240307-v1:0' that Bedrock was denying access to. Also
consolidated the duplicate inline Bedrock caller in genbi.mjs into the same shared
askClaude() function, so there's only one place the model ID is ever set. Covered
by a regression test (genbi-bedrock-model.test.mjs) asserting neither the constant
nor the actual Bedrock invocation ever uses the deprecated ID.
EOF
)"

gh issue close 7 --comment "$(cat <<'EOF'
Shipped -- the Stats page is now a two-pane layout: a "League Intelligence" pane on
the left (question input + suggested questions) and a "League Analysis" pane on the
right showing the answer, token usage, and query duration. Closing as done; please
reopen if the intended design differs from what's live.
EOF
)"

echo "Done. Run 'gh issue list --state closed' to confirm."
