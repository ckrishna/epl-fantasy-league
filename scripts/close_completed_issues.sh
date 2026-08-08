#!/usr/bin/env bash
# One-time script: closes the GitHub issues that are now actually done, and updates
# #22 with a note (not closed -- only the league_id half of that issue is done, the
# gross/net scoring toggle part is still open as originally scoped).
#
# Closing:
#   #32 - season dropdown (task #14) -- shipped: /seasons endpoint, ?season= param,
#         frontend dropdown, API Gateway route added and verified live
#   #35 - manually verify fpl-global-stats-weekly post-rollover -- done, confirmed
#         season_id=2 populated cleanly, season_id=1 untouched
#   #36 - re-verify ingester once managers joined 2026/27 -- done, confirmed live
#         with 4+ real managers via the new_entries fallback fix
#   #37 - fpl_league_standings.rank dead code -- resolved: removed entirely
#   #23 - old "convert to season_id" proposal -- superseded by the season_string
#         dynamic-resolution approach that shipped instead (commented on this
#         earlier, closing now)
set -euo pipefail

gh issue close 32 --comment "$(cat <<'EOF'
Shipped. handleStandings/handleWinners now accept ?season=, a new /seasons
endpoint lists every season on record, the frontend has a season dropdown in
the header, and browsing a past season never touches live FPL data (verified
via a test that fails loudly if it does). API Gateway route added and tested
live end-to-end -- 2025/26 and 2026/27 both browsable now.
EOF
)"

gh issue close 35 --comment "Done -- manually invoked fpl-global-stats-weekly post-rollover, confirmed player_event_stats/fpl_fixture_data populate cleanly under season_id=2 with zero impact on season_id=1's data."

gh issue close 36 --comment "Done -- once real managers joined the 2026/27 league, the ingester picked them up correctly (this was the new_entries fallback fix from #34's sibling bug, confirmed live with 4+ managers processed successfully)."

gh issue close 37 --comment "Resolved: removed the rank field entirely from fpl-data-ingester's standings write. It was always hardcoded to 0, and the frontend already computes rank client-side from sort order and never read the stored value -- so this was dead weight, not a bug to fix."

gh issue close 23 --comment "Closing -- confirmed resolved via the season_string dynamic-resolution approach (see earlier comment on this issue for details). Verified end-to-end with the eval suite and a live season rollover to 2026/27."

gh issue comment 22 --body "$(cat <<'EOF'
Update: the league_id half of this is now done -- league_id lives on the
seasons table row, fpl-data-ingester reads it dynamically instead of a
hardcoded constant, and throws clearly if it's missing rather than silently
using a stale value. The gross/net scoring toggle part of this issue is
still open as originally scoped -- leaving this issue open for that.
EOF
)"

echo "Done. Run 'gh issue list' to confirm."
