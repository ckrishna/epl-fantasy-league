## Problem

`Finish` and `Gap to 1st` on the Trends "Season by season" table (`handleTrends` in
`lambda/stats-api/handlers/trends.mjs`) are computed by `rankAt()` / `leaderPointsAt()`,
which pool **every row that exists for that season/gameweek across the whole
`fpl_entry_gameweek` table** — not just the managers in the requesting manager's own
league/group for that season. The only scoping that happens today is at the season
level, via `getAllowedSeasonsForLeague()` (which seasons are even eligible to show) —
there's no per-row filter restricting the comparison pool to the manager's own group.

This is currently harmless: `DATA_MODEL.md` confirms only one group is registered today
("Carpe Diem", `group_id: carpe-diem`), so every row for every season on record happens
to belong to the same league. But the whole point of the `leagues` / `groups` /
`group_seasons` registry (tasks #104-129) was to support onboarding more than one
league. The moment a second league's data shares a season with the first (e.g. both
start tracking in the same FPL season), `Finish`/`Gap to 1st` would silently start
comparing a manager against a blended field from both leagues — wrong, but wrong in a
way that looks completely plausible, with no error or indication anything's off.

## Fix

Scope `rankAt()`/`leaderPointsAt()`'s comparison pool (`bySeasonGw`) to only the real
names/person_ids who belong to the requesting manager's own group for that season,
using the same `people`/`group_seasons` join Trends already uses to resolve identity
across season boundaries (task #126). Rows from other groups sharing a season should
be excluded from the field entirely, not just left in.

## Also: show which league these numbers are relative to

Right now the "Season by season" table has no visible indicator of which league's field
`Finish`/`Gap to 1st` are computed against — there's nothing to notice even if a user
suspects the numbers might mean something different for an older season, a differently-named
league, etc. Add some indicator (league/group name, e.g. from `groups.name`) near the
table or column headers so it's clear which league's standings these two columns
reflect, especially once more than one group is registered.

## Scope

Backend: `lambda/stats-api/handlers/trends.mjs` (`rankAt`, `leaderPointsAt`, `bySeasonGw`
construction). Frontend: `src/pages/Trends.jsx`'s "Season by season" table — add the
league/group name indicator.

Related: task #120 (Trends cross-season group scoping, but for *which seasons are
eligible*, not *who's compared within a season*), task #126 (Trends rewired onto
`people`/`group_seasons`).
