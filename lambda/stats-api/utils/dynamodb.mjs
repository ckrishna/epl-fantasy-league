import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));

export const FPL_API = 'https://fantasy.premierleague.com/api';
export const FPL_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// Single source of truth for "what season is currently active", matching the same
// `seasons` table pattern already used by fpl-bootstrap, fpl-global-stats-weekly, and
// the GenBI handler. Centralizing it here means season rollover is a single write to
// that table (flip `current` to the new season), not a hunt through hardcoded strings.
//
// NOTE: the `seasons` table has two different season fields -- `season_id` (a numeric
// internal ID used to tag reference tables like `teams`/`players`/`events`) and
// `season_string` (the human-readable "2025/26" used as the partition-key prefix for
// manager-facing tables like fpl_entry_gameweek/fpl_league_standings/gw-winners-cache).
// This function must return `season_string`, not `season_id`.
export async function getCurrentSeason() {
  const { season } = await getCurrentSeasonInfo();
  return season;
}

// Same lookup as getCurrentSeason(), but also returns the numeric season_id -- for
// callers (like the GenBI handler) that need both the manager-facing season_string
// AND the numeric ID used by reference tables (teams/player_event_stats/etc), so they
// don't have to scan the seasons table twice.
export async function getCurrentSeasonInfo() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'seasons',
    FilterExpression: '#c = :curr',
    ExpressionAttributeNames: { '#c': 'current' },
    ExpressionAttributeValues: { ':curr': true }
  }));

  if (result.Items && result.Items.length > 0) {
    const item = result.Items[0];
    // leagueId added 2026-08-15 so callers (GenBI's multi-league scoping) can resolve
    // "which league is this season's default" without a second scan -- additive, every
    // existing caller destructures only { season, seasonId } and ignores the rest.
    return { season: item.season_string, seasonId: item.season_id, leagueId: item.league_id ?? null };
  }
  throw new Error('No current season found in seasons table');
}

// Shared "which league" filter for the two tables the ingester now stamps league_id
// onto (fpl_league_standings, gw-winners-cache -- added 2026-08-14, see DATA_MODEL.md's
// multi-league notes). Every row written before that has no league_id attribute at
// all, and is kept unconditionally rather than excluded -- there is no ambiguity to
// resolve for a row written back when this app had only ever tracked one league.
// leagueId itself is optional throughout this file's exports specifically so every
// EXISTING caller that hasn't been updated to pass one keeps working unfiltered,
// exactly as before this was added.
function filterByLeagueId(items, leagueId) {
  if (leagueId == null) return items;
  return items.filter((item) => item.league_id == null || String(item.league_id) === String(leagueId));
}

export async function queryLeagueStandings(gw, season, leagueId = null) {
  const currentSeason = season || await getCurrentSeason();
  const result = await dynamodb.send(new QueryCommand({
    TableName: 'fpl_league_standings',
    KeyConditionExpression: 'season_event = :se',
    ExpressionAttributeValues: { ':se': `${currentSeason}#${gw}` }
  }));
  return filterByLeagueId(result.Items || [], leagueId);
}

export async function getGWWinners(season, leagueId = null) {
  const currentSeason = season || await getCurrentSeason();
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'gw-winners-cache',
    FilterExpression: 'season = :s',
    ExpressionAttributeValues: { ':s': currentSeason }
  }));
  return filterByLeagueId(result.Items || [], leagueId);
}

// Resolves the set of entry_ids belonging to a given league_id for a season -- the join
// key GenBI's season-wide aggregate functions need now that a second league (added
// 2026-08-15, task #48/#139) can share the same season's fpl_entry_gameweek/
// fpl_entry_picks data. Those two tables deliberately never got their own league_id
// column (see DATA_MODEL.md's "Multi-league targeted fix" -- a manager's raw GW score is
// the same fact regardless of which league is asking), so there's no way to filter them
// directly; fpl_league_standings is the one table that already carries league_id, and
// its sort key `manager_id` is written straight from `manager.entry_id` by the ingester
// (see index.mjs's storeStandings) -- same underlying FPL id, different attribute name
// on this one table.
//
// Scans the whole season (every stored gameweek), not a single gameweek's Query like
// queryLeagueStandings -- membership shouldn't depend on which gameweek happened to be
// picked, and collecting the union across every stored gameweek is the safer read if a
// manager's row is ever missing from one particular gameweek.
//
// Deliberately does NOT reuse filterByLeagueId's "keep if league_id is null" passthrough
// -- that's the right call for DISPLAYING an ambiguous pre-multi-league row (nothing to
// exclude it for), but the wrong call here: a roster is being used to positively include
// managers in one specific league's aggregates, and an ambiguous row has no business
// being confidently attributed to any one league. In practice this only matters for
// seasons predating the 2026-08-14 league_id stamping -- 2026/27 onward, every row
// already carries a real league_id.
//
// Returns null (meaning "no scoping, keep today's full-table behavior") when leagueId is
// null/undefined, or when nothing was found at all for that league+season -- an empty
// roster almost certainly means the data isn't there yet (a league registered but not
// yet backfilled, or a genuinely empty pre-season standings table), not that zero people
// should see any data. Silently excluding every manager from GenBI would be a much worse
// failure mode than briefly falling back to unscoped behavior.
export async function getLeagueRoster(leagueId, season) {
  if (leagueId == null) return null;
  const currentSeason = season || await getCurrentSeason();
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'fpl_league_standings',
    FilterExpression: 'begins_with(season_event, :prefix)',
    ExpressionAttributeValues: { ':prefix': `${currentSeason}#` }
  }));
  const matching = (result.Items || []).filter(
    (row) => row.league_id != null && String(row.league_id) === String(leagueId)
  );
  const entryIds = new Set(matching.map((row) => String(row.manager_id)));
  return entryIds.size > 0 ? entryIds : null;
}

// Returns every row in the `seasons` table (not just the current one), newest first.
// Powers the season dropdown -- a user needs to see 2025/26 even once 2026/27 is current.
export async function getAllSeasons() {
  const result = await dynamodb.send(new ScanCommand({ TableName: 'seasons' }));
  return (result.Items || []).slice().sort((a, b) => (b.season_id ?? 0) - (a.season_id ?? 0));
}

// Finds the highest gameweek we actually have per-manager data for, scoped to the
// given season (defaults to current). Used two ways: (1) as a last-resort fallback
// when the live FPL API is unreachable or hasn't told us anything useful (see
// getActiveGameweek below), and (2) as the *primary* way to resolve "last gameweek"
// when browsing a past season, since live FPL data is never relevant to history.
export async function getLatestStoredGameweek(season) {
  const currentSeason = season || await getCurrentSeason();
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'fpl_entry_gameweek',
    FilterExpression: 'season = :s',
    ExpressionAttributeValues: { ':s': currentSeason }
  }));
  const gameweeks = (result.Items || []).map((i) => i.gameweek).filter((gw) => typeof gw === 'number');
  if (gameweeks.length === 0) return 1;
  return Math.max(...gameweeks);
}

// Determines "today's" gameweek. Historically this trusted FPL's live `is_current`
// flag and fell back to a hardcoded `26` whenever that flag wasn't set -- which is
// exactly what happens for the entire off-season once a season concludes, and is why
// the dashboard got stuck defaulting to GW25 after the 2025/26 season ended at GW38.
//
// Fixed behavior:
//   1. If FPL marks a gameweek as current, use it (normal in-season case).
//   2. Otherwise, if FPL has any finished gameweeks, use the most recent one (this is
//      what makes the post-season case resolve to the true final gameweek).
//   3. If neither of those work (FPL unreachable, or genuinely before GW1), fall back
//      to whatever gameweek we ourselves have the most recent stored data for.
export async function getActiveGameweek() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`, { headers: FPL_FETCH_HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const current = data.events.find((e) => e.is_current);
    if (current) return current.id;

    const finished = data.events.filter((e) => e.finished);
    if (finished.length > 0) {
      return Math.max(...finished.map((e) => e.id));
    }

    return await getLatestStoredGameweek();
  } catch (err) {
    return await getLatestStoredGameweek();
  }
}
