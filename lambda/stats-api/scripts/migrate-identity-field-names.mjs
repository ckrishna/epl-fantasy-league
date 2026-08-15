// One-time (but safely re-runnable/resumable) migration: renames the long-standing
// team_name/manager_name field-naming inversion to explicit real_name/team_nickname
// across the 3 tables that actually store these fields as attributes --
// fpl_entry_gameweek, fpl_league_standings, gw-winners-cache. (fpl_entry_picks has no
// such fields of its own -- it joins to a name via fpl_entry_gameweek -- so it's
// untouched.)
//
// MUTATES EXISTING LIVE ROWS -- unlike backfill-people.mjs / seed-default-group.mjs,
// this is not purely additive. Back up all 3 tables before running for real (see
// DATA_MODEL.md's identity redesign section for the exact aws dynamodb create-backup
// commands). Always run with --dry-run first and review the sample output before
// writing anything.
//
// Usage: node scripts/migrate-identity-field-names.mjs [--dry-run] [--table=<name>]
//   --dry-run prints counts + a few sample before/after rows without writing.
//   --table restricts to one table (fpl_entry_gameweek | fpl_league_standings |
//   gw-winners-cache) -- useful for reviewing/migrating one table at a time.
//
// Idempotent: an item that no longer has team_name/manager_name is skipped (see
// utils/identity-field-migration.mjs's needsFlatRename/winnersListNeedsRename), so a
// partial failure (e.g. a throttled request) can be safely resumed by re-running the
// exact same command -- already-migrated items are left alone.

import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from '../utils/dynamodb.mjs';
import {
  needsFlatRename,
  renameFlatIdentityFields,
  renameWinnersList,
  winnersListNeedsRename
} from '../utils/identity-field-migration.mjs';

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

async function migrateFlatTable(tableName, keyFields, dryRun) {
  console.log(`\nScanning ${tableName}...`);
  const items = await scanAll(tableName);
  const toMigrate = items.filter(needsFlatRename);
  console.log(`${items.length} items total, ${toMigrate.length} still need renaming.`);

  if (toMigrate.length > 0) {
    console.log('Sample (first 3):');
    for (const item of toMigrate.slice(0, 3)) {
      const key = Object.fromEntries(keyFields.map((k) => [k, item[k]]));
      console.log(`  ${JSON.stringify(key)}: team_name=${JSON.stringify(item.team_name)}, manager_name=${JSON.stringify(item.manager_name)} -> ${JSON.stringify(renameFlatIdentityFields(item))}`);
    }
  }

  if (dryRun) return;

  for (const item of toMigrate) {
    const key = Object.fromEntries(keyFields.map((k) => [k, item[k]]));
    const { real_name, team_nickname } = renameFlatIdentityFields(item);
    await dynamodb.send(new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET real_name = :r, team_nickname = :n REMOVE team_name, manager_name',
      ExpressionAttributeValues: { ':r': real_name, ':n': team_nickname }
    }));
  }
  console.log(`Migrated ${toMigrate.length} items in ${tableName}.`);
}

async function migrateWinnersCache(dryRun) {
  console.log('\nScanning gw-winners-cache...');
  const items = await scanAll('gw-winners-cache');
  const toMigrate = items.filter((item) => winnersListNeedsRename(item.winners));
  console.log(`${items.length} items total, ${toMigrate.length} still need renaming.`);

  if (toMigrate.length > 0) {
    const sample = toMigrate[0];
    console.log('Sample (first item needing migration, its first winner entry):');
    console.log(`  season=${sample.season} gameweek=${sample.gameweek}: ${JSON.stringify(sample.winners[0])} -> ${JSON.stringify(renameWinnersList(sample.winners)[0])}`);
  }

  if (dryRun) return;

  for (const item of toMigrate) {
    await dynamodb.send(new UpdateCommand({
      TableName: 'gw-winners-cache',
      Key: { season: item.season, gameweek: item.gameweek },
      UpdateExpression: 'SET winners = :w',
      ExpressionAttributeValues: { ':w': renameWinnersList(item.winners) }
    }));
  }
  console.log(`Migrated ${toMigrate.length} items in gw-winners-cache.`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tableArg = args.find((a) => a.startsWith('--table='))?.split('=')[1] || null;

  const validTables = ['fpl_entry_gameweek', 'fpl_league_standings', 'gw-winners-cache'];
  if (tableArg && !validTables.includes(tableArg)) {
    console.error(`Unknown --table=${tableArg}. Expected one of: ${validTables.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (!tableArg || tableArg === 'fpl_entry_gameweek') {
    await migrateFlatTable('fpl_entry_gameweek', ['season_entry', 'gameweek'], dryRun);
  }
  if (!tableArg || tableArg === 'fpl_league_standings') {
    await migrateFlatTable('fpl_league_standings', ['season_event', 'manager_id'], dryRun);
  }
  if (!tableArg || tableArg === 'gw-winners-cache') {
    await migrateWinnersCache(dryRun);
  }

  if (dryRun) {
    console.log('\n--dry-run set -- nothing written.');
  }
}

main().catch((err) => {
  console.error('migrate-identity-field-names failed:', err);
  process.exitCode = 1;
});
