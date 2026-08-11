# Data Model

DynamoDB tables backing the EPL Fantasy League app, as confirmed via `aws dynamodb describe-table` on 2026-07-29. All tables are in `us-west-2`.

## The two "season" concepts

There are two unrelated identifiers for "which season," and mixing them up caused a real production bug (see `lambda/fpl-data-ingester/index.mjs` and `lambda/stats-api/utils/dynamodb.mjs`, both have a `getCurrentSeason()` comment explaining this):

- **`season_id`** (Number, e.g. `1`) — an internal surrogate key. Used as the partition key for the *reference* tables below (`teams`, `players`, `element_types`, `events`, `player_event_stats`, `fpl_fixture_data`).
- **`season_string`** (String, e.g. `"2025/26"`) — the human-readable season. Used as the partition-key prefix for the *league* tables (`fpl_entry_gameweek`, `fpl_entry_picks`, `fpl_league_standings`, `gw-winners-cache`).

Both live as attributes on the same row in the `seasons` table. Code that needs to resolve "the current season" must read the correct one for its table family.

## Schema diagram

Logical relationships shown here aren't enforced by DynamoDB (no real foreign keys) -- this reflects how the code joins tables via `season_id`/`season_string`, not a database-level constraint.

```mermaid
erDiagram
    seasons {
        number season_id PK
        string season_string "e.g. 2026/27"
        boolean current "exactly one true"
        string status
        number total_gameweeks
        number league_id "FPL classic league ID"
    }

    teams {
        number season_id PK
        number team_id "SK"
        string name
    }

    players {
        number season_id PK
        number player_id "SK"
        string web_name
        number total_points
    }

    element_types {
        number season_id PK
        number element_type_id "SK"
        string singular_name
    }

    events {
        number season_id PK
        number gameweek_id "SK"
        boolean is_current
        boolean finished
    }

    player_event_stats {
        number season_id PK
        string gameweek_player "SK: gw#player_id"
        number total_points
    }

    fpl_fixture_data {
        string season_fixture PK "season_id#fixture_id"
        number event "SK: gameweek"
        string status
    }

    fpl_entry_gameweek {
        string season_entry PK "season_string#entry_id"
        number gameweek "SK"
        number entry_id
        number points_total
    }

    fpl_entry_picks {
        string season_entry_gw PK "season_string#entry_id#gw"
        string position_player "SK: squad_pos#player_id"
        boolean is_captain
    }

    fpl_league_standings {
        string season_event PK "season_string#gameweek"
        number manager_id "SK"
        number total_points
        boolean backfilled "true if reconstructed"
    }

    gw_winners_cache {
        string season PK "gw-winners-cache table"
        number gameweek "SK"
        string winners
    }

    seasons ||--o{ teams : "season_id"
    seasons ||--o{ players : "season_id"
    seasons ||--o{ element_types : "season_id"
    seasons ||--o{ events : "season_id"
    seasons ||--o{ player_event_stats : "season_id"
    seasons ||--o{ fpl_fixture_data : "season_id (embedded in key)"
    seasons ||--o{ fpl_entry_gameweek : "season_string (embedded in key)"
    seasons ||--o{ fpl_entry_picks : "season_string (embedded in key)"
    seasons ||--o{ fpl_league_standings : "season_string (embedded in key)"
    seasons ||--o{ gw_winners_cache : "season_string"
    fpl_entry_gameweek ||--o{ fpl_entry_picks : "entry_id + gameweek"
    fpl_entry_gameweek }o--|| fpl_league_standings : "entry_id = manager_id"
```

---

## `seasons`

The single source of truth for which season is active. Nothing in the four Lambdas writes to this table — it's maintained manually (console or an out-of-repo script).

**Key schema:** partition key `season_id` (N) only, no sort key.

| Attribute | Type | Notes |
|---|---|---|
| `season_id` | N | e.g. `1` — internal ID, joins to reference tables |
| `season_string` | S | e.g. `"2025/26"` — joins to league tables |
| `current` | BOOL | exactly one row should be `true` at a time |
| `status` | S | e.g. `"active"` |
| `start_date` / `end_date` | S (ISO) | |
| `total_gameweeks` | N | `38` |
| `league_id` | N | e.g. `438107` — the FPL classic mini-league ID for this season. Added 2026-07-30 so a league-ID change (already happened once, 212889 → 438107) is a data update instead of a code change + redeploy. **Required** on the current row — `fpl-data-ingester` throws if it's missing. |
| `created_at` / `updated_at` | S (ISO) | |

Read by: `fpl-bootstrap`, `fpl-global-stats-weekly`, `genbi.mjs` (all read `season_id`); `stats-api` and `fpl-data-ingester` (read `season_string`); `fpl-data-ingester` also reads `league_id`.

Item count: 2 — `season_id=1` (2025/26, retired, `current: false`) and `season_id=2` (2026/27, `current: true`). `season_id=2` needs a `league_id` attribute added before `fpl-data-ingester` will run successfully.

---

## Reference tables (league-wide, written by `fpl-bootstrap`)

All four share the same key shape: partition key `season_id` (N), sort key as noted.

**Read-by audit (2026-08-11):** of these four tables, only `teams` is actually read anywhere else in the codebase (`genbi.mjs`'s `getAllTeamsForSeason`, and only for the `team_id -> name` mapping -- a value that's effectively frozen for the whole season). `players`, `element_types`, and `events` are written but never read by any other Lambda or handler -- all real player-level data GenBI/the dashboard actually show comes from `player_event_stats` (written weekly by `fpl-global-stats-weekly`), not this table. `events` was already known dead (see its own note below); `players` and `element_types` turn out to be the same.

**Scheduling:** `fpl-bootstrap` had no EventBridge rule at all until 2026-08-11 -- it only ever ran manually, and nobody could say for certain it would get re-run at the start of a new season without someone remembering to do it by hand. Given the read-by audit above, a tight refresh cadence wouldn't actually buy anything (the one thing that's consumed barely changes within a season), so the fix wasn't "run it more often for freshness" -- it's `fpl-bootstrap-weekly`, `cron(0 2 ? * SUN *)` (Sundays 02:00 UTC, chosen to not collide with the nightly ingester's 04:00 UTC or the weekly stats job's Tuesday 03:00 UTC), purely as a cheap safety net so the season_id-seeding step can't silently get missed at rollover. A weekly no-op re-write of near-static data costs nothing.

### `teams`
Sort key: `team_id` (N). 20 items (one per PL club).
Fields: `name`, `short_name`, `code`, `strength*` (home/away, attack/defence), `form`, `points`, `position`, `played`, `wins`/`draws`/`losses`, `unavailable`, `pulse_id`, `team_division`, `last_synced`.

### `players`
Sort key: `player_id` (N). 817 items.
Fields: `first_name`/`second_name`/`web_name`, `team_id`, `element_type`, `now_cost`, `total_points`, `points_per_game`, `form`, `selected_by_percent`, `status`, match-stat totals (goals/assists/clean_sheets/cards/saves/bonus/bps), ICT index components, expected-stats (xG/xA/xGI/xGC), `transfers_in`/`transfers_out`, `value_form`/`value_season`, `last_synced`.

### `element_types`
Sort key: `element_type_id` (N). 4 items (GK/DEF/MID/FWD).
Fields: `singular_name`(_short), `plural_name`(_short), squad composition rules (`squad_select`, `squad_min/max_select`, `squad_min/max_play`), `element_count`, `last_synced`.

### `events`
Sort key: `gameweek_id` (N). 38 items (one per gameweek).
Fields: `name`, `deadline_time`(+epoch/offset), `release_time`, `finished`, `released`, `data_checked`, `is_current`, `is_previous`, `is_next`, `average_entry_score`, `highest_score`, `highest_scoring_entry`, `most_selected`/`most_transferred_in`/`most_captained`/`most_vice_captained`, `top_element`(+info), `chip_plays`, `last_synced`.

**Note:** nothing in the codebase actually queries this table — every Lambda that needs live gameweek status re-fetches `bootstrap-static` from the FPL API directly instead. Redundant but not a bug.

---

## Gameweek-level reference tables (written by `fpl-global-stats-weekly`)

### `player_event_stats`
Partition key `season_id` (N), sort key `gameweek_player` (S, composite `"{gameweek}#{player_id}"`, supports `begins_with` queries by gameweek). **29,338 items, ~17.7MB — by far the largest table.**
Fields: player identity/team/position, per-gameweek match stats (goals, assists, clean sheets, cards, saves, bonus, bps), ICT components, defensive contribution stats, expected-stats, `selected_by_percent`, `form`, `fixture`, `opponent_team`, `was_home`, `last_synced`. **Real field is `total_points`, not `points`** — `genbi.mjs` read the wrong field name for a long time, silently sending every player to Claude as 0 points (fixed 2026-08-08). **`form` (FPL's own per-player rolling form score) was written here from day one but never read by `genbi.mjs`'s `players_gw_data` mapping** — a "which players are in form?" question had nothing to answer from except `recent_form_summary`, which is actually a per-*manager* win-streak count, a completely different field that happens to share the word "form" (fixed 2026-08-09; see `bedrock.mjs`'s PLAYER FORM vs MANAGER FORM definitions).
Read by: `genbi.mjs` (AI query feature) — both for a single requested gameweek, and aggregated across the whole season for "this season" questions (see gap note below).

### `player_season_totals` (new, 2026-08-08)
Partition key `season_string` (S, e.g. `"2025/26"`), sort key `player_name` (S). Populated by the one-off `scripts/backfill-season-totals.mjs`, not by any regular ingestion pipeline.
Fields: `team_name` (current-bootstrap team — may not match the player's team *during* that season if they've since transferred), `total_points`, `minutes`, `goals_scored`, `assists`, `element_code`, `last_synced`.
Why it exists: `player_event_stats` has known per-gameweek gaps for 2025/26 (see below), so summing it ourselves undercounts anyone caught in a gap week. This table instead stores FPL's own authoritative season-total, read from each current player's `history_past` entry — accurate regardless of our own ingestion gaps, but only covers players still in FPL's current player pool (anyone who's left the league since has no current element ID to look this up against).
Read by: `genbi.mjs` (`getAuthoritativeSeasonTotals`) — preferred over the live `player_event_stats` aggregation whenever data exists for the requested season; falls back to the live aggregation otherwise.

### `fpl_fixture_data`
Partition key `season_fixture` (S, composite `"{season_id}#{fixture_id}"`), sort key `event` (N, the gameweek number). 385 items.
Fields: `fixture_id`, `season_id`, `gameweek`, `team_h`/`team_a` (+ names), scores, difficulty ratings, `kickoff_time`, `status` (FINISHED/STARTED/PENDING), `minutes`, `last_synced`.

---

## League tables (your mini-league's data, written by `fpl-data-ingester`)

### `fpl_entry_gameweek`
Partition key `season_entry` (S, `"{season_string}#{entry_id}"`), sort key `gameweek` (N).
**396 items.** 11 managers × 36 gameweeks average — expected 38, so there's likely a second gap beyond the known GW26 one.
Fields: `entry_id`, `season`, `manager_name`, `team_name`, `points_this_week`, `points_gross`, `transfer_cost`, `points_total`, `transfers_made`/`transfers_remaining`, `active_chip`, `bank`, `value`, `gw_winner`, `last_synced`, `data_version`.
Read by: `genbi.mjs` (`getLatestStoredGameweek`); also `genbi.mjs` (`getManagerSeasonAggregates`, added 2026-08-09, #39 Phase 1) — full-season `Scan` filtered by `season`, one pass, folded into per-manager totals (highest/lowest single-GW score via `points_this_week`, season average via the highest `points_total` seen, transfer activity via `transfers_made`/`transfer_cost`, chip usage via `active_chip`).

### `fpl_entry_picks`
Partition key `season_entry_gw` (S, `"{season}#{entry_id}#{gw}"`), sort key `position_player` (S, `"{squad_position}#{player_id}"`). 6,337 items.
Fields: `season`, `entry_id`, `gameweek`, `player_id`/`player_name`/`player_position`/`player_team`, `squad_position`, `is_captain`, `is_vice_captain`, `multiplier`, `points`, `is_starter`/`is_bench`, `last_synced`, and (only on backfilled rows, see below) `points_backfilled` (BOOL) / `points_backfill_source` (S).
Read by: `genbi.mjs` (`getOurLeaguePicks`, via a `Scan` + `FilterExpression` on `gameweek` — not a `Query`, since `gameweek` isn't part of this table's key). Also `genbi.mjs` (`getManagerSeasonAggregates`, added 2026-08-09, #39 Phase 1) — full-season `Scan` filtered by `season`, summing `points` where `is_bench`/`is_captain` per manager (season bench-points-wasted, season captaincy points). Has no `manager_name` of its own; joined to a name via an `entry_id -> manager_name` map built from `fpl_entry_gameweek` in the same request, rather than a third query.

**Bug (found + fixed 2026-08-10):** the `our_league_picks` mapping in `genbi.mjs` read `pick.manager_name` directly, but that field never existed on this table's items (confirmed against `fpl-data-ingester`'s `storePicks()` write — only `entry_id`). Every `<manager_picks>` entry GenBI ever sent to Claude had `manager: undefined`, for the entire life of the captain-picks feature — no test caught it because every existing test either hand-built `leagueContext` directly (bypassing the real mapping) or only asserted that the fetch happened, never that the resulting values were correct. Fixed by adding `getManagerNamesForGW(gw, season)` (single-gameweek-scoped `Scan` of `fpl_entry_gameweek`, cheaper than the season-wide scan `getManagerSeasonAggregates` already does) and joining through it; unresolvable `entry_id`s fall back to `"Unknown"` rather than `undefined`.

**#39 Phase 2 (2026-08-10):** `computeOwnershipAggregates(picks, nameByEntryId)` — a pure function, no extra query — reuses the same picks + name-map data already fetched above to compute `most_owned_player` and `differentials` (players owned by exactly one manager in *our* league, sorted by that gameweek's points) for `<ownership_aggregates>`. Explicitly scoped to our league's own squads only, never FPL's site-wide ownership percentages (that's the unrelated `selected_by_percent` field on `player_event_stats`).

**Bug (found + fixed 2026-08-10):** `points` was always `0` for every row in this table, confirmed against live data for both 2025/26 GW20 and GW38 (all 3,144 scanned rows). Root cause: `storePicks()` read `pick.points` from FPL's `/entry/{id}/event/{gw}/picks/` endpoint, but that endpoint's `picks` array only ever contains `element`, `position`, `multiplier`, `is_captain`, `is_vice_captain` — no `points` field, ever. Per-player gameweek points live on a completely separate endpoint (`/event/{gw}/live/`, keyed by player element id), which the ingester never fetched. This silently zeroed out `bench_points_wasted` and `captain_points_season` (#39 Phase 1) and `ownership_aggregates`'s `points_this_gw` (#39 Phase 2) from the moment those features shipped.
Fixed by adding `getLiveGameweekStats(gw)` to `fpl-data-ingester/index.mjs` — fetches `/event/{gw}/live/` once per gameweek in `gwsToFetch` (not once per manager; the handler now does this fetch up front and passes the resulting `Map<element_id, points>` into every `storePicks()` call for that gameweek), and joins each pick's `points` from it instead of the nonexistent `pick.points`. `points` is stored as the player's RAW gameweek score, not pre-multiplied by squad role — `bench_points_wasted` wants the raw score regardless of the bench multiplier being 0 anyway, and `getManagerSeasonAggregates`'s `captain_points_season` now applies the stored `multiplier` field itself (`pts * multiplier`, so a triple-captain chip correctly counts x3, not a flat x2) rather than assuming `points` was already multiplied.
**Historical 2025/26 data is NOT lost, but FPL's own API can't recover it.** Confirmed live 2026-08-11: `curl https://fantasy.premierleague.com/api/event/38/live/` now returns `{"elements":[]}` — that endpoint has no season in its URL, it's bound to whatever season is current on FPL's backend, and once 2026/27 existed, last season's per-gameweek live data was gone from it.

What DOES still have it: `player_event_stats`, populated weekly by a completely different (and never-broken) pipeline, `fpl-global-stats-weekly`. Verified live 2026-08-11: all 38 gameweeks of 2025/26 are present in `player_event_stats` for `season_id=1`, with real non-zero `total_points` (e.g. GW38: Kelleher 6, Collins 3, Lewis-Potter 5). Player element IDs were also confirmed to line up exactly between the two tables for the same season (`player_id=101` is "Kelleher" in both, `player_id=106` is "Collins" in both) — both pipelines read the same season's `bootstrap-static` while it was live, so identity is consistent within a season even though it isn't guaranteed to be stable *across* seasons.

`lambda/fpl-data-ingester/scripts/backfill-picks-points.mjs` (added 2026-08-11) backfills `fpl_entry_picks.points` for a completed season by joining each row to `player_event_stats` on `season_id` + `gameweek` + `player_id` — entirely against our own DynamoDB tables, no FPL API calls at all. Backfilled rows get `points_backfilled: true` / `points_backfill_source: 'player_event_stats'` (same marker convention as the GW26 standings backfill below), so they stay distinguishable from rows written by the fixed live ingester going forward.

**Run 2026-08-11 for "2025/26":** 6,209 of 6,337 rows (98%) successfully backfilled with real points. The remaining 128 rows (all from GW31 and GW34) stayed at `points: 0` — not a new gap, this is the same known `player_event_stats` hole already documented above (~150-250 players missing for those two specific gameweeks), so there was genuinely nothing to backfill them from.

### `fpl_league_standings`
Partition key `season_event` (S, `"{season_string}#{gameweek}"`), sort key `manager_id` (N). 396 items (was 385 as of the describe-table snapshot; +11 from the GW26 backfill below).
**Has a GSI: `manager_id-season_event-index`** (HASH `manager_id`, RANGE `season_event`) — not currently used by any code, but would let you query one manager's full season history directly instead of scanning.
Fields: `manager_name`, `team_name`, `total_points`, `points_this_week`, `transfer_cost`, `last_synced`, and (only on backfilled rows) `backfilled` (BOOL) / `backfill_source` (S). (No `rank` field — removed 2026-07-30; it was always hardcoded to `0` and the frontend already computes rank client-side from sort order, so it was dead weight.)
Read by: `stats-api` (`queryLeagueStandings`) — this is what the live dashboard's Standings page reads. Also read by `genbi.mjs` (`getCurrentStandings`, added 2026-08-08) — GenBI previously had no access to real points/rank at all, only win *counts* derived from `gw-winners-cache`, so "what are the standings" / "who's leading" questions were unanswerable. Reuses `queryLeagueStandings` directly and mirrors its walk-back-a-gameweek fallback, since this table's gaps (e.g. the GW26 outage above) are independent of the tables GenBI's other context fields read from.

**GW26 backfill (2026-07-29):** `find_gaps.py` showed GW26 was the only gameweek missing from `fpl_league_standings` for *every* manager (a one-night cache-write outage), even though the underlying `fpl_entry_gameweek` raw data for GW26 existed. `scripts/backfill_gw26_standings.py` reconstructed the 11 missing rows from `fpl_entry_gameweek` and wrote them with `backfilled: true` / `backfill_source: 'fpl_entry_gameweek'` so they stay distinguishable from organically-ingested rows. Verified two ways: live `/standings?gw=26` now returns all 11 managers, and the backfilled totals chain correctly into GW27's real (non-backfilled) data for every manager checked (e.g. Da Movement: 1562 + 35 = 1597, matching GW27's recorded total exactly; same check passed for Suberox and Team).

### `gw-winners-cache`
Partition key `season` (S), sort key `gameweek` (N). 38 items — full season's worth, despite the gaps above (winners get computed per-gameweek from whichever managers *do* have data that gameweek, so a single manager's gap doesn't necessarily blank out the whole week).
Fields: `winners` (list of `{entry_id, manager_name, team_name, net_points, gross_points, transfer_cost}`), `is_current`, `last_synced`.
Read by: `stats-api` (`getGWWinners`) and `genbi.mjs`.

---

## `ingestion_runs` (new, 2026-08-08)

Partition key `function_name` (S, e.g. `"fpl-data-ingester"`), sort key `started_at` (S, ISO timestamp — sorts newest-last within a function's partition; query with `ScanIndexForward: false` for most-recent-first).

Fields: `finished_at` (S, ISO), `duration_ms` (N), `status` (`"success"` \| `"failure"`), `trigger` (`"scheduled"` \| `"manual"` — derived from the Lambda event shape: EventBridge's own scheduled invocations always carry `source: "aws.events"`), `season` (S, nullable — whichever season the run resolved, null if it failed before resolving one), `summary` (Map, shape varies per function — item counts, error counts, whatever that function already tracked), `error_message` (S, nullable, only set on failure).

Written by all three ingestion Lambdas (`fpl-bootstrap`, `fpl-data-ingester`, `fpl-global-stats-weekly`) at the end of every invocation, success or failure. The write itself is wrapped in try/catch so a logging failure can never fail the actual ingestion job — same resilience pattern already used for `genbi.mjs`'s budget-warning email.

**Why this exists:** this project had zero history of whether nightly/weekly syncs actually ran or succeeded — flagged as an open gap below for a while before finally being built. Confirmed via `aws events list-rules` that, as of 2026-08-09, only two of the three ingestion Lambdas were on a schedule: `fpl-data-ingester` runs nightly (`fpl-nightly-pull` rule, `cron(0 4 * * ? *)` — 04:00 UTC daily) and `fpl-global-stats-weekly` runs weekly (`cron(0 3 ? * TUE *)` — Tuesdays 03:00 UTC). `fpl-bootstrap` had no EventBridge rule at all at that point — it only ever ran when invoked manually. Fixed 2026-08-11 (`fpl-bootstrap-weekly`, `cron(0 2 ? * SUN *)` — Sundays 02:00 UTC); see the read-by audit and scheduling rationale in the Reference tables section above for why weekly (not nightly) was the right cadence.

**Coverage note:** `fpl-data-ingester` has automated tests for its `ingestion_runs` writes (`tests/ingestion-runs.test.mjs`). `fpl-bootstrap` and `fpl-global-stats-weekly` have no test infrastructure at all (no `tests/` directory, no mock helpers) — their writes were verified by code review only, not automated tests. Building out eval harnesses for those two is unstarted work, not just untested-by-oversight.

**Table needs to be created in DynamoDB before this goes live** — same as any new table introduced by code (e.g. `player_season_totals`), nothing in this repo provisions infrastructure.

---

## `genbi-query-log` (new, 2026-08-09)

Partition key `query_id` (S, UUID — generated per request, no sort key).

Fields: `timestamp` (S, ISO), `date` (S, `"YYYY-MM-DD"` UTC — denormalized off `timestamp` so a future scan/GSI over "today's questions" doesn't need to parse it client-side), `question` (S), `season` (S), `gameweek` (N), `fields_selected` (Map — the deterministic router's output for this question, see `utils/router.mjs`), `answer` (S), `input_tokens` (N), `output_tokens` (N), `cost_usd` (N), `duration_ms` (N), `feedback` (S, `"up"` \| `"down"` \| `null` — null until a manager votes), `feedback_at` (S, ISO, nullable — set the same time `feedback` is).

Written by `genbi.mjs` (`recordQueryLog`, in `utils/genbi-log.mjs`) after every successfully answered question, right after the budget/cost bookkeeping. The generated `query_id` is also returned to the frontend in the GenBI response body. `feedback`/`feedback_at` are filled in later, if at all, by `submitFeedback()` (same file) via the thumbs-up/down buttons on the Stats page -- a conditional update (`attribute_exists(query_id)`) so voting against an unknown/stale query_id fails loudly (404) instead of silently creating a bogus row. Both writes are wrapped in try/catch — same resilience pattern as `ingestion_runs` and the budget-warning email; a logging failure never blocks the manager's answer.

**Deliberately scoped to the successful path only.** Budget-blocked requests (`budget_exceeded: true`) and hard errors (statusCode 500) are not logged here — neither has an answer, token count, or router decision to record, and giving them a row would mean a second, differently-shaped schema. Revisit if visibility into declined/failed questions turns out to matter once this has real usage.

**Why this exists:** a feedback loop — question logging, thumbs-up/down feedback, then using that feedback to find genuinely good vs. bad answers and improve the router/prompt from real usage instead of guessing. See `fields_selected` in particular: this also lets the router's real-world accuracy be measured later against actual questions asked, not just its own unit tests. A manager can change their vote (re-submitting just overwrites `feedback`); there's no separate history of vote changes.

**Table needs to be created in DynamoDB before this goes live** — same as `ingestion_runs` above.

**Coverage note:** covered by `tests/genbi-query-log.test.mjs` (`recordQueryLog()` + its wiring into `handleGenBI()`) and `tests/genbi-feedback.test.mjs` (`submitFeedback()` + `handleGenBIFeedback()`, including the not-found-vs-real-failure distinction). No frontend test coverage for the Stats.jsx thumbs buttons -- this repo has no frontend test infrastructure at all yet, same gap noted elsewhere.

---

## Gap analysis (2026-07-29, via `scripts/find_gaps.py`)

Ran a full scan of both league tables against the expected 11 managers × 38 gameweeks. Two distinct issues found:

- **`fpl_league_standings`, GW26 — full outage, all 11 managers.** The raw `fpl_entry_gameweek` data for GW26 existed, so this was a cache-write failure, not a data-loss issue. **Fixed** via the backfill described above.
- **`fpl_entry_gameweek`, entry_id 5327224 (Sunil Mathew) — missing GW3 through GW24.** Present at GW1-2 and again from GW25 onward, so this isn't "joined late" or "left the league" — something else caused a 22-week gap with no re-join event. Root cause not identified (checked and ruled out: late entry). **Deprioritized at the user's direction** — not under active investigation.

## Gap analysis (2026-08-08, `player_event_stats`)

Found while debugging GenBI giving a wrong "most points this season" answer. Row counts per gameweek for 2025/26 are consistently ~750-840 except two: **GW31 (664 rows) and GW34 (582 rows)** — each missing roughly 150-250 players, not a full outage. Confirmed via a specific example: Haaland's rows sum to 222 in our data (missing exactly GW31 and GW34), vs. FPL's own authoritative record of 239 for that season.

FPL's live API no longer exposes gameweek-by-gameweek detail for a completed past season (`element-summary`'s `history` field only covers the currently active season) — so this gap **cannot be backfilled at the gameweek level** anymore. Worked around instead by adding `player_season_totals`, sourced from FPL's own season-level `history_past` field, which sidesteps the gap entirely rather than reconstructing it. **Root cause of the original GW31/34 gap itself was not investigated** (same category of issue as the Sunil Mathew gap above — a historical ingestion completeness problem, not something actively broken today).

## Open questions / follow-ups (not yet investigated)

- Sunil Mathew's GW3-24 gap in `fpl_entry_gameweek` (see Gap analysis above) — cause unknown, parked.
- Root cause of the `player_event_stats` GW31/GW34 partial gap (see Gap analysis above) — worked around via `player_season_totals`, not investigated further.
- The GSI on `fpl_league_standings` isn't used anywhere — worth considering if a "manager history" view is ever wanted.
- `player_season_totals` only covers players still in FPL's current player pool — anyone who left the Premier League since a given past season has no current element ID to backfill against, so they'll still fall back to the (gappy) live aggregation.
