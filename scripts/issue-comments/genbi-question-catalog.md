# GenBI question catalog: coverage audit + roadmap

A brainstormed list of questions a manager in our league would realistically want to
ask GenBI -- pure curiosity about league stats, plus "how do I catch the leader"
strategy questions. Cross-checked against what `router.mjs`, `genbi.mjs`, and
`bedrock.mjs` actually support today (2026-08-12), not guessed.

Legend: ✅ supported today · ⚠️ partially supported / needs a prompt or aggregate
change · ❌ not supported, needs new work (or should be explicitly declined, not
guessed)

## Standings & season overview

| Question | Status | Notes |
|---|---|---|
| What are the current standings? | ✅ | `current_standings` |
| What's my rank, and how many points behind 1st am I? | ✅ | `current_standings` has rank + points; gap is arithmetic |
| Who's had the most GW wins this season? | ✅ | `total_season_summary` |
| What's the biggest single-GW score this season, and who had it? | ✅ | max of `highest_gw_score` across `manager_season_stats` |
| Who's on the best form right now? | ✅ | `recent_form_summary` |
| Who's cooling off (declining trend)? | ❌ | `recent_form_summary` is a last-5-GW win *count*, not a direction/trend signal |
| How has the gap to 1st changed over the last 5 GWs? | ❌ | no historical standings-over-time field exists; `current_standings` is a single snapshot |

## Catching the leader (strategy)

| Question | Status | Notes |
|---|---|---|
| How many transfers/hits has the leader taken vs me? | ✅ | `manager_season_stats.total_transfers_made/total_transfer_hits` |
| Has it paid off? | ❌ | no per-transfer point-delta log; same known gap as "best transfers" |
| How much of the leader's lead is captaincy vs squad points? | ⚠️ | computable from `captain_points_season` + `current_standings.total_points`, but no prompt instruction tells Claude to do this math today |
| How many points have I left on my bench vs the leader? | ✅ | `bench_points_wasted` |
| If I closed that bench gap, where would I actually rank? | ⚠️ | computable (my total + gap vs others' `current_standings.total_points`) but no instruction guides this "what-if" calc today |
| What chips does the leader have left that I don't? | ✅ | `chips_used`/`chips_used_totals`, 2 minus used, per type |
| Has the leader played their wildcard/free hit yet? | ✅ | same as above |
| When are they likely to play it again? | ❌ | pure speculation, no data supports this -- should be explicitly declined, not guessed |

## Captaincy

| Question | Status | Notes |
|---|---|---|
| Highest total captain points this season? | ✅ | `captain_points_season` |
| Who's captained the most across our league this GW? | ✅ | `our_league_picks` (`is_captain` flag) |
| Best captain calls relative to rest of squad? | ⚠️ | needs captain points as a % of total -- computable, not modeled |

## Ownership & differentials

| Question | Status | Notes |
|---|---|---|
| Which player is a differential this week? | ✅ | `ownership_aggregates.differentials` |
| Most-owned player right now? | ✅ | `ownership_aggregates.most_owned_player` |
| Is there a player owned by everyone except me? | ⚠️ | routes correctly (keyword `owned`) but `ownership_aggregates` only computes most-owned + exactly-one-owner cases today, not "all but one" |

## Transfers & hits

| Question | Status | Notes |
|---|---|---|
| Most transfers this season? | ✅ | `total_transfers_made` |
| Most hits taken? | ✅ | `total_transfer_hits` |
| Did the hits net out positive? | ❌ | same per-transfer-log gap as above |
| Who made the best transfers? | ❌ | already documented as out of scope (issue #39) |

## Chips

| Question | Status | Notes |
|---|---|---|
| How many chips does each manager have left, by type? | ⚠️ | computable (2 minus used) but needs a prompt instruction |
| Who's used triple captain/bench boost, and when? | ✅ (current season) / ⚠️ (2025/26, totals only, no GW) | `chips_used` vs `chips_used_totals` |
| Did the chip pay off that gameweek? | ⚠️ | would need to cross-reference the chip's GW against that GW's score -- possible, not wired |

## Player value / performance

| Question | Status | Notes |
|---|---|---|
| Best value picks (points per £m)? | ❌ | needs price + points exposed together -- part of task #65 |
| Which of my players is underperforming price/ownership? | ❌ | same, task #65 |
| Form pick nobody in our league owns yet? | ⚠️ | likely mostly works today (form + ownership fields both exist and both route in for a compound question) but untested |

## Streaks & rivalry

| Question | Status | Notes |
|---|---|---|
| Longest win streak this season? Am I on one now? | ✅ | `longest_win_streak`, `current_win_streak` |
| Most consistent scorer (smallest best/worst GW gap)? | ✅ | computable from `highest_gw_score` - `lowest_gw_score` |
| Who's my closest rival in the table? | ⚠️ | computable from adjacent `current_standings` ranks, no instruction today |
| Last-5-GW head-to-head score comparison vs a rival? | ❌ | no per-GW score history is currently surfaced (it exists in `fpl_entry_gameweek`, just not exposed as a field GenBI can read) |

## Fun / banter

| Question | Status | Notes |
|---|---|---|
| Worst single gameweek this season, and who had it? | ✅ | min of `lowest_gw_score` |
| Whose team has changed the least (fewest transfers)? | ✅ | min of `total_transfers_made` |

## Suggested build order

1. **Prompt-only wins (no new data, no new aggregates)** -- cheapest, do first: chips remaining by type, captaincy-share-of-lead, hypothetical rank if bench gap closed, closest-rival-in-standings, captain-quality-relative-to-squad. All of these are arithmetic over fields we already send; they just need `bedrock.mjs` instructions telling Claude to do the math and an eval per instruction.
2. **New aggregates, existing data** -- medium effort: "owned by everyone except me" (extend `ownership_aggregates`), "did the chip pay off" (join chip GW to that GW's score), last-5-GW head-to-head (surface recent per-GW scores from `fpl_entry_gameweek`, which we already store -- just never exposed as a field), form-trend/"cooling off" direction.
3. **Task #65 (already tracked)** -- best value picks, underperforming-vs-price. Needs the bonus/BPS/ICT/xG/price enrichment work.
4. **Explicitly decline, don't build** -- "did hits pay off" / "best transfers" (no per-transfer log, already a known documented gap) and "when will they play their chip next" (pure speculation) -- these should get an honest decline in the prompt, not a guess.

Always excludes explicit non-goals already documented in #39: no per-transfer buy/sell log exists, so any question judging "quality" of a specific transfer stays out of scope until that changes.
