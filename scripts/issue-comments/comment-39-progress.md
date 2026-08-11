Progress update:

**Phase 1 (shipped, `9c60b90`):** per-manager season aggregates — current/longest GW-win streak, highest/lowest single-gameweek score, season average points, transfer activity (count + points lost to hits), chip usage (which chip, which gameweek), bench points wasted, season-long captaincy points. Wired end-to-end: router keyword group (`managerStats`) → `getManagerSeasonAggregates`/`computeWinStreaks` → `<manager_season_stats>` prompt tag → new instruction with an explicit honesty guardrail ("who made the most transfers" is answerable from activity counts; "who made the BEST transfers" still isn't, since there's no player-level transfer log).

**Phase 2 (shipped, `849840c`):** ownership aggregates — most-owned player and differentials (players owned by exactly one manager in this league, sorted by that gameweek's points), scoped strictly to our own league's squads, never FPL's site-wide ownership %.

**Two real bugs found and fixed along the way, both pre-dating this issue:**
- `849840c` — `our_league_picks` read `pick.manager_name` directly, but that field never existed on `fpl_entry_picks` rows (only `entry_id`). Every `<manager_picks>` entry GenBI has ever sent to Claude had `manager: undefined` for the life of the captain-picks feature. Fixed via a proper `entry_id -> manager_name` join.
- `168d91c` — `fpl_entry_picks.points` was always `0` for every row, confirmed live against 2025/26 GW20 and GW38 (3,144 scanned rows, all zero). The ingester was reading `pick.points` from an FPL endpoint that never has that field; fixed by joining against FPL's live per-gameweek stats endpoint instead. This had silently zeroed out Phase 1's `bench_points_wasted`/`captain_points_season` and Phase 2's `points_this_gw` since each shipped.
- `0592f64` — backfilled the historical 2025/26 rows (can't be recovered from FPL's API anymore post-rollover, but recoverable from our own `player_event_stats` table, which was never broken). 6,209/6,337 rows (98%) backfilled with real points; the remaining 128 hit an already-documented `player_event_stats` gap for GW31/GW34, not a new issue.

**Still open:** Phase 3 (restructure `<instructions>` into an explicit routing table, make the suggested-questions UI honest about what's actually answerable) and Phase 4 (live-model eval harness). Neither started yet.
