// One-off backfill: fixes fpl_entry_picks.points for a completed past season, sourced
// from our OWN already-ingested player_event_stats table -- not FPL's live API.
//
// Why this exists: storePicks() in index.mjs read `pick.points` from FPL's
// /entry/{id}/event/{gw}/picks/ endpoint, but that endpoint never has a points field at
// all (only element/position/multiplier/is_captain/is_vice_captain). Every row in
// fpl_entry_picks has had points: 0 since the table's inception (confirmed live against
// 2025/26 GW20 and GW38 -- all 3,144 scanned rows). index.mjs is now fixed to source
// real points from FPL's /event/{gw}/live/ endpoint going forward, but that endpoint has
// no season in its URL and is bound to whatever season is CURRENT on FPL's backend --
// once 2026/27 existed, `/event/38/live/` for 2025/26 started returning {"elements":[]}
// (confirmed live 2026-08-11). So FPL's API can no longer backfill last season.
//
// What CAN backfill it: player_event_stats. It's populated weekly, live, by a
// completely different (and never-broken) pipeline -- fpl-global-stats-weekly -- and
// still has real per-gameweek, per-player total_points for all 38 gameweeks of 2025/26
// (verified live 2026-08-11: every GW 1-38 present in player_event_stats for
// season_id=1). Player element IDs are stable WITHIN a season (both pipelines read the
// same season's bootstrap-static while it was live), confirmed by cross-checking real
// rows: player_id 101 = "Kelleher" in both tables, player_id 106 = "Collins" in both,
// for the same 2025/26 GW38.
//
// This only touches the completed season it's pointed at. It does NOT help 2026/27 --
// that season's ingester runs already write real points going forward via the
// index.mjs fix, so there's nothing to backfill there.
//
// Usage: node scripts/backfill-picks-points.mjs [season_name]
//   node scripts/backfill-picks-points.mjs           -> defaults to "2025/26"
//   node scripts/backfill-picks-points.mjs "2024/25" -> backfill a different season
//
// Run this locally (needs your AWS credentials; no network access to FPL needed at all
// -- every read and write here is against our own DynamoDB tables). Takes a few minutes
// for ~6,300 rows.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const TARGET_SEASON = process.argv[2] || '2025/26';

async function getSeasonId(seasonString) {
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'seasons',
    FilterExpression: 'season_string = :s',
    ExpressionAttributeValues: { ':s': seasonString }
  }));
  const match = (result.Items || [])[0];
  if (!match) throw new Error(`No row in "seasons" for season_string "${seasonString}"`);
  return match.season_id;
}

async function getAllPicksForSeason(seasonString) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_picks',
      FilterExpression: 'season = :s',
      ExpressionAttributeValues: { ':s': seasonString },
      ExclusiveStartKey: lastEvaluatedKey
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

async function main() {
  console.log(`Backfilling fpl_entry_picks.points for "${TARGET_SEASON}" from player_event_stats...`);

  const seasonId = await getSeasonId(TARGET_SEASON);
  console.log(`Resolved season_id=${seasonId} for "${TARGET_SEASON}".`);

  const picks = await getAllPicksForSeason(TARGET_SEASON);
  console.log(`Found ${picks.length} fpl_entry_picks rows for "${TARGET_SEASON}".`);

  let matched = 0;
  let updated = 0;
  let noMatch = 0;
  let errors = 0;
  const noMatchSample = [];

  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];

    if (i % 250 === 0) {
      console.log(`Progress: ${i}/${picks.length} (matched=${matched}, updated=${updated}, no_match=${noMatch}, errors=${errors})`);
    }

    try {
      const statsResult = await dynamodb.send(new GetCommand({
        TableName: 'player_event_stats',
        Key: {
          season_id: seasonId,
          gameweek_player: `${pick.gameweek}#${pick.player_id}`
        }
      }));

      if (!statsResult.Item) {
        noMatch += 1;
        if (noMatchSample.length < 10) {
          noMatchSample.push(`GW${pick.gameweek} player_id=${pick.player_id} (${pick.player_name})`);
        }
        continue;
      }

      matched += 1;
      const realPoints = statsResult.Item.total_points ?? 0;

      await dynamodb.send(new UpdateCommand({
        TableName: 'fpl_entry_picks',
        Key: {
          season_entry_gw: pick.season_entry_gw,
          position_player: pick.position_player
        },
        UpdateExpression: 'SET points = :p, points_backfilled = :b, points_backfill_source = :src, last_synced = :ls',
        ExpressionAttributeValues: {
          ':p': realPoints,
          ':b': true,
          ':src': 'player_event_stats',
          ':ls': new Date().toISOString()
        }
      }));
      updated += 1;
    } catch (err) {
      errors += 1;
      console.error(`Failed for GW${pick.gameweek} player_id=${pick.player_id} (${pick.player_name}): ${err.message}`);
    }
  }

  console.log('');
  console.log('Done.');
  console.log(`  Rows scanned:              ${picks.length}`);
  console.log(`  Matched in player_event_stats: ${matched}`);
  console.log(`  Updated:                   ${updated}`);
  console.log(`  No match (left at 0):      ${noMatch}`);
  console.log(`  Errors:                    ${errors}`);
  if (noMatchSample.length > 0) {
    console.log(`  Sample unmatched:          ${noMatchSample.join('; ')}`);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
