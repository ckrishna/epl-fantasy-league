## Priority note

Unlike #48 (multi-league support) and most of #137 (which are both about supporting
*other/larger* leagues), this affects the ingester's reliability for our own existing
league today -- any FPL rate-limit or throttling response currently goes undetected
regardless of league size. Should be prioritized ahead of multi-league work.

## Problem: a rate-limited (or any failed) picks fetch is indistinguishable from "no data yet"

Two different failure classes exist in `lambda/fpl-data-ingester/index.mjs`, and only
one of them is visible:

- `getBootstrapStatic()` and the league-standings fetch inside `getLeagueManagers()`
  both `throw` on a non-ok response. A rate-limit hit there fails the whole invocation
  loudly -- `ingestion_runs` gets `status: 'failed'` with an `error_message` like
  `"HTTP 429"`, visible in that table or CloudWatch Logs.

- `getManagerPicksForGW()` -- the highest-volume call in the whole pipeline (one per
  manager per gameweek, and therefore the single most likely place to actually get
  rate-limited) -- does `if (!response.ok) return null` with no status code captured
  anywhere. The caller (around line 368) logs `"No data for GW N"` at INFO level and
  moves on. This is byte-for-byte identical to the completely normal case of a manager
  who genuinely hasn't played that gameweek yet. A 429 here is invisible.

## Problem: the self-throttle gets skipped on exactly the runs that need it most

The 1-second `setTimeout` after a successful picks fetch+store (line 379) only runs on
the success path. When `picksData` comes back null, the code `continue`s straight to
the next manager, skipping the pause entirely. So if FPL starts rejecting requests, the
ingester speeds up instead of backing off -- the opposite of what should happen under
rate-limiting.

## Only indirect signal today

`ingestion_runs` records `api_calls` and `db_writes` per run (plus `duration_ms`,
`status`, `error_message`). A silently-dropped batch of picks would show up as
`db_writes` unusually low relative to (managers x gameweeks that run touched) -- but
nothing computes or alerts on that ratio. You'd have to notice it by manually querying
the table.

## Fix

1. Capture and log the actual HTTP status code when a picks fetch comes back non-ok,
   distinguishing a real error (429/500/etc.) from a legitimate empty result, and
   record it in that gameweek's log line / `ingestion_runs` summary rather than folding
   it into a generic "no data" INFO log.
2. Don't skip the self-throttle delay on the failure path -- if anything, back off
   *more* (e.g. a longer pause or a single retry) specifically on a 429, not less.
3. Consider a simple retry-with-backoff for a 429 specifically on the picks endpoint,
   since a single manager's picks failing shouldn't need to wait for the next scheduled
   run to be recovered.

## Scope

`lambda/fpl-data-ingester/index.mjs` (`getManagerPicksForGW`, the per-manager loop
around line 364-380, `recordIngestionRun`'s summary shape).

Related: #137 (pagination/cap -- that's about supporting larger leagues; this is about
detecting failures regardless of league size).
