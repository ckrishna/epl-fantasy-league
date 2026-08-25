#!/usr/bin/env bash
# One-time script: closes the 4 "Tier 1" Advisor roadmap issues (GH #55-58), all
# shipped and deployed together in commit 6fcc26e ("Advisor: real Bench Boost bench +
# ranked "which chip" comparison"), which also carried the Bench Boost/chip-comparison
# work that surfaced afterward. Verified live via GET /manager-squad/advisor --
# suggestTransfer's scoring now reflects all four bonuses, confirmed by the full
# backend test suite (293 tests, lambda/stats-api/tests/squad-advisor.test.mjs).
#
# Rewritten to use `gh issue comment --body-file` against committed .md files
# (scripts/issue-comments/) rather than inline heredocs -- the first version of this
# script hit a heredoc-parsing failure on a re-run (mid-file it errored with
# "unexpected EOF while looking for matching `'", closing #55 but leaving #56-58
# untouched). Reading each comment body from its own file sidesteps quoting/line-ending
# issues entirely, matching how this repo already handles longer issue comments
# elsewhere (see the other .md files in this same directory).
#
# Safe to re-run: `gh issue comment` on an issue is never destructive (just posts
# another copy of the same comment), and `gh issue close` on an already-closed issue
# is a no-op that exits 0.
#
# Does NOT close #59-64 (Tier 2/3: top-100-overall ingestion, real Differential/Captain
# Pick, elite chip-timing, article ingestion) -- those are still unstarted. Does NOT
# close #43 or #44 (the two Advisor epics) -- both still have open sub-scope (#43's
# top-1000 ingestion, #44's Captain Pick/Differential Pick still mock).
set -euo pipefail
cd "$(dirname "$0")"

for n in 55 56 57 58; do
  gh issue comment "$n" --body-file "issue-comments/comment-$n.md"
  # #55 was already closed by the previous (broken) run of this script -- `|| true`
  # so re-closing an already-closed issue doesn't abort the loop before #56-58 run.
  gh issue close "$n" || true
done

gh issue comment 44 --body-file "issue-comments/comment-44-tier1-progress.md"

echo "Done. Run 'gh issue list --state closed' to confirm."
