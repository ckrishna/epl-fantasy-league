// One-time (but safely re-runnable) seed: creates the FIRST `groups` row -- our own
// original league, "Carpe Diem" -- plus one `group_seasons` row per season we actually have
// data for. Read-only against fpl_entry_gameweek and seasons; only ever writes to the new
// `groups`/`group_seasons` tables. Re-running is idempotent: `groups`/`group_seasons` rows
// use if_not_exists for created_at/added_at, so a re-run refreshes league_id (e.g. once a
// season's league_id gets backfilled onto `seasons` later) without duplicating rows or
// clobbering when a row was first seen.
//
// Usage: node scripts/seed-default-group.mjs --name "Carpe Diem" [--dry-run]
//   --name is required -- a group's display name is a human judgment call, not something
//   this script should guess (see utils/groups.mjs's header comment).
//   --dry-run prints what would be written without writing anything.
//
// Requires AWS credentials with read access to fpl_entry_gameweek/seasons and write access
// to groups/group_seasons. Assumes both tables already exist -- see DATA_MODEL.md's
// people/groups/group_seasons section for the schema + create-table commands.

import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from '../utils/dynamodb.mjs';
import { slugify, deriveGroupSeasons } from '../utils/groups.mjs';

async function scanAll(tableName) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const nameFlagIndex = argv.indexOf('--name');
  const name = nameFlagIndex !== -1 ? argv[nameFlagIndex + 1] : null;
  return { dryRun, name };
}

async function main() {
  const { dryRun, name } = parseArgs(process.argv.slice(2));
  if (!name) {
    console.error('Usage: node scripts/seed-default-group.mjs --name "Carpe Diem" [--dry-run]');
    console.error('--name is required.');
    process.exitCode = 1;
    return;
  }

  console.log('Scanning fpl_entry_gameweek for distinct seasons (read-only)...');
  const gwRows = await scanAll('fpl_entry_gameweek');
  const seasonStrings = gwRows.map((r) => r.season).filter(Boolean);

  console.log('Scanning seasons for known league_ids (read-only)...');
  const seasonRows = await scanAll('seasons');
  const leagueIdBySeasonString = {};
  for (const row of seasonRows) {
    if (row.season_string && row.league_id != null) {
      leagueIdBySeasonString[row.season_string] = row.league_id;
    }
  }

  const groupId = slugify(name);
  const groupSeasons = deriveGroupSeasons({ groupId, seasonStrings, leagueIdBySeasonString });

  console.log(`\nGroup: ${groupId}  ("${name}")`);
  console.log(`group_seasons (${groupSeasons.length}):`);
  for (const gs of groupSeasons) {
    console.log(`  ${gs.season_string}  league_id=${gs.league_id ?? 'null'}`);
  }

  if (dryRun) {
    console.log('\n--dry-run set -- nothing written.');
    return;
  }

  console.log('\nWriting `groups` row...');
  const now = new Date().toISOString();
  await dynamodb.send(new UpdateCommand({
    TableName: 'groups',
    Key: { group_id: groupId },
    UpdateExpression: 'SET #name = :name, #src = :source, created_at = if_not_exists(created_at, :now)',
    ExpressionAttributeNames: { '#name': 'name', '#src': 'source' },
    ExpressionAttributeValues: {
      ':name': name,
      ':source': 'seed-default-group-2026-08-14',
      ':now': now
    }
  }));

  console.log('Writing `group_seasons` rows...');
  for (const gs of groupSeasons) {
    await dynamodb.send(new UpdateCommand({
      TableName: 'group_seasons',
      Key: { group_id: gs.group_id, season_string: gs.season_string },
      UpdateExpression: 'SET league_id = :leagueId, #src = :source, added_at = if_not_exists(added_at, :now)',
      ExpressionAttributeNames: { '#src': 'source' },
      ExpressionAttributeValues: {
        ':leagueId': gs.league_id,
        ':source': 'seed-default-group-2026-08-14',
        ':now': now
      }
    }));
  }
  console.log(`Wrote 1 group + ${groupSeasons.length} group_seasons rows.`);
}

main().catch((err) => {
  console.error('seed-default-group failed:', err);
  process.exitCode = 1;
});
