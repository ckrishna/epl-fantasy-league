## Problem 1: ongoing ingestion never paginates league standings

`getLeagueManagers()` in `lambda/fpl-data-ingester/index.mjs` fetches a single page --
`GET /leagues-classic/{id}/standings/` with no `page_standings`/`page_new_entries`
param -- and uses that page's `results` directly. It never reads FPL's own `has_next`
flag on `standings`/`new_entries`, and never fetches a second page.

`lambda/stats-api/utils/league-validation.mjs`'s onboarding check (`countLeagueEntries`)
already does this correctly -- it loops on `has_next` until it runs out of pages or
crosses the cap. The ongoing ingester never adopted the same pattern.

FPL's classic-league standings endpoint is itself paginated. Any league with more
members than fit on the first page will have every manager past that page silently
missing from `Standings`/`GW Winners`/`Trends` -- no error, they just never appear.
This isn't specific to the 100-entry cap below; it would already be broken today for
any league that started out larger than one page, regardless of whether it's under the
onboarding cap. Not caught yet because our only registered league has 8 members (one
page). Confirmed via the ingester's own test fixtures: every mock in
`tests/league-new-entries-fallback.test.mjs` and `tests/ingestion-runs.test.mjs` only
ever sets `has_next: false` -- the multi-page path has never been exercised.

## Problem 2: the 100-entry cap is a one-time gate, not an ongoing guard

`MAX_LEAGUE_ENTRIES` (`league-validation.mjs`, default 100) is only checked once, in
`validateLeagueForOnboarding()`, called by `scripts/add-league.mjs` at registration
time. Nothing re-checks a league's size on any later ingestion run. A league added at
60 members that organically grows to 150 over a season triggers no warning, no error,
and no re-validation -- it just keeps running. Combined with Problem 1, the actual
symptom isn't a hard failure; it's newly-joined members quietly never showing up
anywhere in the app once the league crosses whatever page size FPL uses, well before
100.

The cap's own reasoning (see the comment above `MAX_LEAGUE_ENTRIES`) is specifically
about bounding sequential per-manager `picks/` API calls during ingestion (both
steady-state weekly syncs and the one-time mid-season backfill for a newly-added
league) within the Lambda's timeout. Worth double-checking that reasoning against the
*actual* deployed timeout for `fpl-data-ingester` (confirmed live 2026-08-15: 300
seconds / 5 minutes) rather than the "15-minute" figure the comment assumes -- at 100
managers x 9 gameweeks = 900 sequential calls for a mid-season backfill, that math may
already be too optimistic even within the cap, separate from the pagination bug above.

## Fix

1. Give `getLeagueManagers()` the same pagination loop `countLeagueEntries()` already
   has -- follow `has_next` on both `standings` and `new_entries` until exhausted.
2. Either re-run entry-count validation on a schedule (e.g. once per week alongside the
   regular sync) and surface a warning/alert if a registered league exceeds
   `MAX_LEAGUE_ENTRIES`, or explicitly document that growth past the cap is undetected
   by design and rely on manual monitoring instead.
3. Re-check the backfill call-count math against `fpl-data-ingester`'s real configured
   timeout (300s, not 15 minutes) and adjust `MAX_LEAGUE_ENTRIES` or the backfill
   strategy (e.g. batching, async continuation) accordingly if the numbers don't hold up.

## Scope

`lambda/fpl-data-ingester/index.mjs` (`getLeagueManagers`), `lambda/stats-api/utils/league-validation.mjs`
(`MAX_LEAGUE_ENTRIES`, `countLeagueEntries` as the reference pagination implementation
to reuse), `lambda/fpl-data-ingester/tests/league-new-entries-fallback.test.mjs` and
`tests/ingestion-runs.test.mjs` (need a multi-page/`has_next: true` case added).

Related: #48 (multi-league support -- this bug applies per-league, so it matters more
as soon as more than one league is registered, but is not exclusive to that feature).
