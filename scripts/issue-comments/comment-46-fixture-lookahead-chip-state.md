Prompted by an Athletic/NYT piece on early-Bench-Boost strategy (2026-08-14) -- worth
recording two concrete, buildable gaps between what we have today and what
chip/fixture-timing advice actually needs.

**We already have more of the foundation than it looks:**
- `fpl_fixture_data` stores FPL's own 1-5 fixture-difficulty rating per team per
  fixture (`team_h_difficulty`/`team_a_difficulty`).
- `manager-squad.mjs`'s `getUpcomingFixtures` already reads it to show each player's
  next two fixtures with difficulty.
- `genbi.mjs`'s `getNextGwProjections` already combines that with FPL's own `ep_next`
  (expected points) for a next-gameweek captain/strategy signal.

**Gap 1 -- everything above is one gameweek deep.** Chip-timing advice like this
article's ("Coventry face Man City away in GW3", "tougher fixtures in GW3-4 for
Man Utd/Chelsea/Sunderland") requires scanning a *run* of upcoming fixtures per team,
not just the immediate next one. This is an extension of `getUpcomingFixtures`/
`getFixturesForGW`, not new data -- the FDR values needed are already in
`fpl_fixture_data`.

**Gap 2 -- no chip-state awareness.** We track chips a manager has already *used*
(`chips_used` in `genbi.mjs`), but nothing tells the advisor "this manager still has
their Bench Boost available" before it suggests playing one. Any "should I Bench
Boost this week" feature needs remaining-chip state per manager, not just history.

**Worth double-checking separately:** this article notes 2026/27 introduced two sets
of chips, split by a GW19 deadline (each chip usable once before GW19, once after).
Worth confirming nothing in our chip tracking assumes "each chip used at most once
per season" -- that assumption may now be wrong for this season specifically.

Filing this against #46 since it's the closest existing issue (forward-looking
strategy questions using FPL projections) -- #44 (squad-move advisor) and #43
(top-1000 ingestion + advisor) are the other two in the same cluster and would also
benefit from a real multi-GW fixture-run util once one exists.
