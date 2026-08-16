// Resolves which seasons Trends' cross-season manager walk should consider, scoped to
// the same continuing group of managers as a given league_id -- see DATA_MODEL.md's
// "Identity redesign" notes for the full reasoning (FPL recycles league_id every
// season, so `group_seasons` -- not the raw league_id -- is what actually links
// multiple seasons together as "the same friend group", via its durable `group_id`).
//
// Replaces utils/league-groups.mjs, which resolved the same thing from the older
// `leagues`/`league_group_id` design. That file is left in place untouched for now
// (see DATA_MODEL.md task #128 -- deciding the old `leagues` table's fate is a
// separate, deliberately deferred decision), but nothing new should import from it;
// this is the live path going forward.
//
// Why Trends specifically needs this: it reads fpl_entry_gameweek via a full,
// unfiltered scan (see trends-data.mjs's getAllGwRows), then matches rows to a manager
// by person identity alone (see utils/people.mjs). That table deliberately has no
// league_id of its own (a manager's raw gameweek score is the same fact regardless of
// which league views it -- see the "targeted fix" scoping decision, 2026-08-14). The
// moment a second, unrelated league's data exists in that same shared table, an
// unscoped identity match could merge two different real people who happen to share a
// name across two completely unrelated leagues. Scoping the SEASONS under
// consideration to the current league's own group closes that off, without needing
// per-manager roster joins.
import { QueryCommand, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from './dynamodb.mjs';

// group_seasons' partition key is group_id, not league_id, so finding "which group is
// this league_id a part of" is a Scan, not a Query -- same tradeoff league-groups.mjs
// made for its own reverse lookup. Fine at this table's size (one row per season per
// group; a healthy number of onboarded leagues is still a tiny table).
async function getGroupIdForLeagueId(leagueId) {
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'group_seasons',
    FilterExpression: 'league_id = :lid',
    ExpressionAttributeValues: { ':lid': Number(leagueId) }
  }));
  return (result.Items || [])[0]?.group_id || null;
}

// Returns a Set of season_strings to allow, or null meaning "no scoping -- match
// against every season, today's behavior". Falls back to null (rather than, say, an
// empty set) in every case where scoping can't be resolved:
//  - leagueId wasn't provided at all (existing callers, or no league context)
//  - leagueId isn't in any group_seasons row yet (a league that's real but hasn't been
//    seeded/onboarded into a group -- see scripts/seed-default-group.mjs /
//    scripts/add-league.mjs -- is a separate, manual, opt-in step)
// This mirrors league-groups.mjs's same deliberate fallback reasoning: until a second,
// unrelated league's data actually exists in the shared fpl_entry_gameweek table,
// restricting the match to fewer seasons than today would only ever make Trends WRONG
// (silently dropping seasons that are still genuinely "you"), for zero real benefit.
export async function getAllowedSeasonsForLeague(leagueId) {
  if (leagueId == null) return null;

  const groupId = await getGroupIdForLeagueId(leagueId);
  if (!groupId) return null;

  const result = await dynamodb.send(new QueryCommand({
    TableName: 'group_seasons',
    KeyConditionExpression: 'group_id = :g',
    ExpressionAttributeValues: { ':g': groupId }
  }));
  const seasons = (result.Items || []).map((item) => item.season_string).filter(Boolean);
  return seasons.length > 0 ? new Set(seasons) : null;
}

// GH #49 -- getAllowedSeasonsForLeague above only answers "which SEASONS should the
// cross-season walk consider"; it says nothing about which MANAGERS within an allowed
// season actually belong to the requesting league. That's fine as long as exactly one
// league's data ever lands in the shared fpl_entry_gameweek table for a given season,
// but breaks the moment a second, unrelated league shares an allowed season (our own
// case now: BETSBANTSSPORT and Carpe Diem both have real 2026/27 data) -- rankAt/
// leaderPointsAt/the "vs the field" worm graph in trends.mjs would blend the wrong
// league's managers into "Finish"/"Gap to 1st"/the worm lines.
//
// Returns a Map of season_string -> league_id for every season in the given league_id's
// group that has a REAL (non-null) league_id -- i.e. only the seasons where a per-league
// roster can actually be resolved via utils/dynamodb.mjs's getLeagueRoster. A season
// missing from this map (pre-2025/26 historical seasons predating real FPL league
// tracking, or a group that's never been registered at all) means "no roster-level
// scoping available" -- callers should leave that season's rows exactly as season-level
// scoping already left them, not guess or exclude anyone.
export async function getSeasonLeagueIdsForGroup(leagueId) {
  if (leagueId == null) return null;

  const groupId = await getGroupIdForLeagueId(leagueId);
  if (!groupId) return null;

  const result = await dynamodb.send(new QueryCommand({
    TableName: 'group_seasons',
    KeyConditionExpression: 'group_id = :g',
    ExpressionAttributeValues: { ':g': groupId }
  }));

  const map = new Map();
  for (const item of result.Items || []) {
    if (item.season_string && item.league_id != null) {
      map.set(item.season_string, item.league_id);
    }
  }
  return map.size > 0 ? map : null;
}

// The group's durable display name (e.g. "Carpe Diem") -- the identity that stays
// constant across seasons even though FPL recycles the underlying league_id every year
// (see this file's header comment). Answers the other half of GH #49 ("show which
// league they reflect"): a Trends response is always scoped to exactly one group, so one
// name for the whole response is enough, no per-season name needed. Returns null if the
// group can't be resolved, or its `groups` row has no name for any reason -- same
// deliberate "don't guess" fallback used throughout this file.
export async function getGroupNameForLeagueId(leagueId) {
  if (leagueId == null) return null;

  const groupId = await getGroupIdForLeagueId(leagueId);
  if (!groupId) return null;

  const result = await dynamodb.send(new GetCommand({
    TableName: 'groups',
    Key: { group_id: groupId }
  }));
  return result.Item?.name || null;
}
