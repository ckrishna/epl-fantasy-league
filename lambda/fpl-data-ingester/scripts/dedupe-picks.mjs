// One-time cleanup: fpl_entry_picks used to key each pick on
// `${squad_position}#${player_id}` (see index.mjs's storePicks, fixed 2026-08-24).
// FPL's own auto-substitution processing (and, separately, a manager editing their
// bench order before a gameweek locks) can change a player's `position` between two
// of our hourly polls of the SAME already-stored gameweek -- every time that happened,
// the OLD sort key's row was never overwritten (only a NEW row got written under the
// new key), leaving a stale duplicate behind forever. Caught live 2026-08-24: a
// manager's squad view showed several players twice, once as a starter and once on
// the bench.
//
// This script finds every (season_entry_gw, player_id) group with more than one row
// and deletes all but the most-recently-synced one (last_synced), which reflects
// whatever position FPL/the manager settled on last -- exactly what the fixed
// storePicks would have produced if it had always used player_id as the sort key.
//
// Usage:
//   node scripts/dedupe-picks.mjs --dry-run   # report what WOULD be deleted, no writes
//   node scripts/dedupe-picks.mjs             # actually delete the stale duplicates
//
// Safe to re-run: once a season_entry_gw/player_id group is down to one row, it's a
// no-op on the next pass.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const TABLE = 'fpl_entry_picks';

async function scanAll() {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastEvaluatedKey }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

// Groups by (season_entry_gw, player_id) -- the two fields that together identify
// "this manager's pick on this player for this gameweek", regardless of how many
// different squad_position/position_player sort-key values got written for it under
// the old (buggy) key scheme.
function groupByEntryGwPlayer(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.season_entry_gw}#${item.player_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

async function batchDelete(keys) {
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    await dynamodb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: batch } }));
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Scanning ${TABLE}...`);
  const items = await scanAll();
  console.log(`Found ${items.length} total items.`);

  const groups = groupByEntryGwPlayer(items);
  const toDelete = [];
  let duplicateGroups = 0;

  for (const [key, group] of groups) {
    if (group.length <= 1) continue;
    duplicateGroups += 1;
    // Keep whichever row was synced most recently; delete the rest. last_synced is an
    // ISO string, so plain string comparison sorts correctly.
    const sorted = [...group].sort((a, b) => (b.last_synced || '').localeCompare(a.last_synced || ''));
    const [keep, ...stale] = sorted;
    if (duplicateGroups <= 10) {
      console.log(`  ${key}: ${group.length} rows -> keeping position_player=${keep.position_player} (last_synced=${keep.last_synced}), deleting ${stale.length}`);
    }
    for (const item of stale) {
      toDelete.push({ season_entry_gw: item.season_entry_gw, position_player: item.position_player });
    }
  }

  console.log(`\n${duplicateGroups} (season_entry_gw, player_id) groups had duplicate rows.`);
  console.log(`${toDelete.length} stale rows to delete.`);

  if (dryRun) {
    console.log('\n--dry-run set -- nothing deleted.');
    return;
  }

  if (toDelete.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  await batchDelete(toDelete);
  console.log(`Deleted ${toDelete.length} stale duplicate rows.`);
}

main().catch((err) => {
  console.error('dedupe-picks failed:', err);
  process.exitCode = 1;
});
