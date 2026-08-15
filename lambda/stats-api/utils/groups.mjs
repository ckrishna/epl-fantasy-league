// The `groups` table (see DATA_MODEL.md's "people/groups/group_seasons" section) replaces
// `league_group_id` as the durable, user-facing entity a manager actually recognizes and
// navigates to ("Carpe Diem"), independent of whichever numeric league_id FPL happens to
// assign in any given season. `group_seasons` is the per-season join, replacing `leagues`:
// group_id + season_string, with league_id nullable since several historical seasons
// (2019/20-2024/25, imported from a spreadsheet -- see DATA_MODEL.md) never had a real FPL
// league_id at all.
//
// Unlike person_id (a pure function of a name), group_id is NOT auto-derived from FPL data --
// a group's display name is a human judgment call (which real name would a manager recognize
// this league by?), so it's supplied explicitly (see scripts/seed-default-group.mjs's --name
// flag) rather than guessed. group_id is a slug of that name: durable, readable, and
// URL-safe, with zero DynamoDB round-trip needed to compute it.

export function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Pure, DynamoDB-free: given every season_string we actually have data for (from a
// fpl_entry_gameweek scan) and whatever league_id each of those seasons is known to have
// (from a seasons table scan -- most historical seasons have none, since they predate real
// FPL league membership and were reconstructed from a spreadsheet, not the FPL API), returns
// one group_seasons row per distinct season, sorted oldest-first.
export function deriveGroupSeasons({ groupId, seasonStrings, leagueIdBySeasonString = {} }) {
  const distinct = [...new Set(seasonStrings.filter(Boolean))].sort();
  return distinct.map((season_string) => ({
    group_id: groupId,
    season_string,
    league_id: leagueIdBySeasonString[season_string] ?? null
  }));
}
