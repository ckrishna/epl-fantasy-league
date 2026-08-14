// Resolves which seasons Trends' cross-season manager walk is allowed to consider,
// scoped to the same continuing group of managers as a given league_id -- see
// DATA_MODEL.md's multi-league notes for the full reasoning (FPL recycles league_id
// every season, so `league_group_id`, set on the `leagues` registry table, is what
// actually links multiple seasons' league_ids together as "the same friend group").
//
// Why Trends specifically needs this: it reads fpl_entry_gameweek via a full,
// unfiltered scan (see trends-data.mjs's getAllGwRows), then matches rows to a manager
// by team_name (real name) alone. That table deliberately has no league_id of its own
// (a manager's raw gameweek score is the same fact regardless of which league views it
// -- see the "targeted fix" scoping decision, 2026-08-14). The moment a second,
// unrelated league's data exists in that same shared table, an unscoped name match
// could merge two different real people who happen to share a name across two
// completely unrelated leagues. Scoping the SEASONS under consideration to the current
// league's own group closes that off, without needing per-manager roster joins.
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from './dynamodb.mjs';

async function getLeagueRow(leagueId) {
  const result = await dynamodb.send(new QueryCommand({
    TableName: 'leagues',
    KeyConditionExpression: 'league_id = :lid',
    ExpressionAttributeValues: { ':lid': Number(leagueId) }
  }));
  return (result.Items || [])[0] || null;
}

// Returns a Set of season_strings to allow, or null meaning "no scoping -- match
// against every season, today's behavior". Falls back to null (rather than, say, an
// empty set) in every case where scoping can't be resolved:
//  - leagueId wasn't provided at all (existing callers, or no league context)
//  - leagueId isn't registered in the `leagues` table (registration -- see
//    scripts/add-league.mjs -- is a separate, manual, opt-in step; not being
//    registered yet is the expected state for most of this app's life so far, not an
//    error condition)
//  - the registered row has no league_group_id set (optional at registration time)
// This is deliberate: until a second, unrelated league's data actually exists in the
// shared fpl_entry_gameweek table, restricting the match to fewer seasons than today
// would only ever make Trends WRONG (silently dropping seasons that are still
// genuinely "you"), for zero real benefit -- there's nothing yet to protect against.
export async function getAllowedSeasonsForLeague(leagueId) {
  if (leagueId == null) return null;

  const ownRow = await getLeagueRow(leagueId);
  const groupId = ownRow?.league_group_id;
  if (!groupId) return null;

  const result = await dynamodb.send(new ScanCommand({
    TableName: 'leagues',
    FilterExpression: 'league_group_id = :g',
    ExpressionAttributeValues: { ':g': groupId }
  }));
  const seasons = (result.Items || []).map((item) => item.season_string).filter(Boolean);
  return seasons.length > 0 ? new Set(seasons) : null;
}
