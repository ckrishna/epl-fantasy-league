#!/usr/bin/env bash
# One-time script: closes the 4 "Tier 1" Advisor roadmap issues (GH #55-58), all
# shipped and deployed together in commit 6fcc26e ("Advisor: real Bench Boost bench +
# ranked "which chip" comparison"), which also carried the Bench Boost/chip-comparison
# work that surfaced afterward. Verified live via
# GET /manager-squad/advisor -- suggestTransfer's scoring now reflects all four bonuses,
# confirmed by the full backend test suite (293 tests, lambda/stats-api/tests/
# squad-advisor.test.mjs).
#
# Does NOT close #59-64 (Tier 2/3: top-100-overall ingestion, real Differential/Captain
# Pick, elite chip-timing, article ingestion) -- those are still unstarted. Does NOT
# close #43 or #44 (the two Advisor epics) -- both still have open sub-scope (#43's
# top-1000 ingestion, #44's Captain Pick/Differential Pick still mock).
set -euo pipefail

gh issue close 55 --comment "$(cat <<'EOF'
Shipped in commit 6fcc26e. getFullPlayerPool() now captures ict_index and
xgi_per_90 (expected_goal_involvements_per_90) per element -- both already
present on every bootstrap-static element, just not previously read into the
pool map. suggestTransfer's candidate ranking (now the shared scorePlayer()
function) adds an underlyingQualityBonus = xgi_per_90*6 + ict_index/40 on
top of the existing ep_next/form weighting, so a player whose underlying
output is strong gets ranked higher even before form/ep_next fully catch up.
Covered by dedicated tests in squad-advisor.test.mjs; full 293-test suite
green.
EOF
)"

gh issue close 56 --comment "$(cat <<'EOF'
Shipped in commit 6fcc26e. selected_by_percent was already being fetched
into the player pool and simply never used -- scorePlayer() now applies a
small subtractive differentialBonus = -(selected_by_percent/20), a
tie-breaker that nudges toward the lower-owned candidate when other scoring
inputs are close, without letting a marginal differential beat a genuinely
better heavily-owned player. Covered by a dedicated test in
squad-advisor.test.mjs.
EOF
)"

gh issue close 57 --comment "$(cat <<'EOF'
Shipped in commit 6fcc26e. New getFixtureRunMap(fixtures, fromGw, numGws)
averages each team's fixture difficulty across a multi-gameweek window
(default 4 GWs), fed into scorePlayer()'s fixtureRunBonus = (3 - avgDifficulty) * 1.5
so a team with an easier-than-average run gets a positive score bonus, a
harder-than-average run a penalty. Used both by suggestTransfer's
transfer-in ranking and the new evaluateTripleCaptain's captain-pick
ranking. Pure function, unit-tested directly against hand-built fixture
arrays in squad-advisor.test.mjs.
EOF
)"

gh issue close 58 --comment "$(cat <<'EOF'
Shipped in commit 6fcc26e. New getUpcomingChipWindows(fixtures, fromGw, numGws)
scans a gameweek window and flags, per gameweek, which teams have zero
fixtures (blank) or 2+ fixtures (double). Exposed on the
/manager-squad/advisor response as upcoming_chip_windows. The same-day
evaluateChipOptions work (see #44) went further and used the single-gameweek
version of this (numGws=1) to power evaluateFreeHit's blank-starter
detection directly, rather than leaving this purely informational.
EOF
)"

gh issue comment 44 --body "$(cat <<'EOF'
Progress update: 2 of the 4 Advisor cards are now real, not mock.

- Squad Change (the transfer suggestion) has been real since an earlier
  pass, and its ranking now also factors in underlying stats (xGI/ICT,
  #55), a light ownership-differential nudge (#56), and multi-gameweek
  fixture-run difficulty (#57) -- all shipped in commit 6fcc26e.
- Chip Watch is now real too: it compares all 4 timing chips (Bench Boost,
  Triple Captain, Free Hit, Wildcard) against the manager's actual
  squad/fixtures and surfaces whichever one genuinely looks strongest this
  week (or says plainly when nothing stands out), instead of always
  defaulting to a hand-written Bench Boost suggestion. Also fixes a bug
  caught live: the old Chip Watch reason named a specific real player who
  wasn't even that manager's bench player.

Still mock: Captain Pick and Differential Pick, both blocked on top-100-
overall ingestion (#43/#59-64, not started).
EOF
)"

echo "Done. Run 'gh issue list --state closed' to confirm."
