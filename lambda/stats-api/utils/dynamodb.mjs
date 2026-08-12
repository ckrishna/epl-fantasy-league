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
    return { season: item.season_string, seasonId: item.season_id };
  }
  throw new Error('No current season found in seasons table');
}

export async function queryLeagueStandings(gw, season) {
  const currentSeason = season || await getCurrentSeason();
  const result = await dynamodb.send(new QueryCommand({
    TableName: 'fpl_league_standings',
    KeyConditionExpression: 'season_event = :se',
    ExpressionAttributeValues: { ':se': `${currentSeason}#${gw}` }
  }));
  return result.Items || [];
}

export async function getGWWinners(season) {
  const currentSeason = season || await getCurrentSeason();
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'gw-winners-cache',
    FilterExpression: 'season = :s',
    ExpressionAttributeValues: { ':s': currentSeason }
  }));
  return result.Items || [];
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
