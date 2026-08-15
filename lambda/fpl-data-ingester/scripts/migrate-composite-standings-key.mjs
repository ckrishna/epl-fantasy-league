// One-time migration: fpl_league_standings and gw-winners-cache both used a sort key
// that can only hold ONE row per (season+gameweek, manager) or (season, gameweek) pair
// -- manager_id (N) and gameweek (N) respectively, with league_id as an ordinary
// (non-key) attribute added later. That's fine for a manager who belongs to exactly one
// league, but breaks the moment a manager belongs to TWO leagues in the same season
// (task #48 -- our own case now: entry_id shared between Carpe Diem and BETSBANTSSPORT).
// Whichever league's write happened last would silently overwrite the other's
// league_id on that single row -- the manager would vanish from the OTHER league's
// Standings/GW-Winners view, not error, just quietly show the wrong thing.
//
// Fix: give each table a composite sort key that includes league_id, so a shared
// manager gets one row per league instead of one row fighting over a single league_id.
//   fpl_league_standings: manager_id (N)  -> league_manager (S) = "{league_id}#{manager_id}"
//   gw-winners-cache:     gameweek (N)    -> gameweek_league (S) = "{gameweek}#{league_id}"
// manager_id/gameweek/league_id all stay as ordinary flat attributes on every item --
// nothing that reads them by name (queryLeagueStandings, getGWWinners, getLeagueRoster
// in stats-api/utils/dynamodb.mjs) needs to change, since none of them ever condition a
// Query/Scan on the OLD sort key value -- only on the partition key, filtering
// league_id in JS afterward. Confirmed by re-reading every call site before choosing
// this approach over, say, a GSI-only fix.
//
// DynamoDB can't alter a live table's key schema in place, so this is delete-and-
// recreate, not an in-place UpdateCommand migration like migrate-identity-field-names.mjs
// in stats-api. Two phases, because the table has to be deleted+recreated by hand
// (via the AWS CLI, see DATA_MODEL.md's migration runbook) BETWEEN them:
//
//   1. EXPORT (before touching the live table at all):
//        node scripts/migrate-composite-standings-key.mjs export --table=fpl_league_standings
//        node scripts/migrate-composite-standings-key.mjs export --table=gw-winners-cache
//      Scans the whole table, writes it to scripts/data/<table>-backup-<timestamp>.json,
//      and prints the item count -- cross-check this against `aws dynamodb describe-table`'s
//      ItemCount before doing anything destructive.
//
//   2. [Manually delete + recreate both tables via the AWS CLI -- see DATA_MODEL.md]
//
//   3. IMPORT (after the tables have the new key schema):
//        node scripts/migrate-composite-standings-key.mjs import --table=fpl_league_standings --file=<path> [--dry-run]
//        node scripts/migrate-composite-standings-key.mjs import --table=gw-winners-cache --file=<path> [--dry-run]
//      Reshapes each backed-up item (adds the new composite sort key attribute; also
//      backfills league_id itself when it's missing AND confidently resolvable from
//      the season -- see SEASON_LEAGUE_ID_MAP below -- leaving it genuinely null, same
//      as today, for any season that never had a real FPL league) and writes it back
//      via BatchWriteCommand. --dry-run prints a sample of before/after reshaping
//      without writing anything.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const __dirname = dirname(fileURLToPath(import.meta.url));

// Grounded in DATA_MODEL.md's group_seasons seed data (seed-default-group.mjs, run
// 2026-08-14) -- the same known-good season -> league_id facts already established
// elsewhere in this schema, not a fresh guess. Deliberately does NOT cover 2026/27+
// beyond what's already known -- a future season rollover needs its own seasons-table
// update anyway (see DATA_MODEL.md's "Runbook: onboarding a new season"), and this
// migration only runs once, now.
const SEASON_LEAGUE_ID_MAP = {
  '2019/20': null,
  '2020/21': null,
  '2021/22': null,
  '2022/23': null,
  '2023/24': null,
  '2024/25': null,
  '2025/26': 212889,
  '2026/27': 438107
};

const VALID_TABLES = ['fpl_league_standings', 'gw-winners-cache'];

async function scanAll(tableName) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastEvaluatedKey }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

async function batchWrite(tableName, items) {
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    await dynamodb.send(new BatchWriteCommand({ RequestItems: { [tableName]: batch } }));
  }
}

function resolveLeagueId(item, seasonString) {
  if (item.league_id != null) return item.league_id;
  const mapped = SEASON_LEAGUE_ID_MAP[seasonString];
  return mapped === undefined ? null : mapped;
}

// fpl_league_standings' season_event is "{season}#{gw}" -- split off just the season.
function seasonFromSeasonEvent(seasonEvent) {
  return String(seasonEvent).split('#')[0];
}

function reshapeStandingsItem(item) {
  const season = seasonFromSeasonEvent(item.season_event);
  const leagueId = resolveLeagueId(item, season);
  return {
    ...item,
    league_id: leagueId,
    league_manager: `${leagueId ?? 'unscoped'}#${item.manager_id}`
  };
}

function reshapeWinnersItem(item) {
  const leagueId = resolveLeagueId(item, item.season);
  return {
    ...item,
    league_id: leagueId,
    gameweek_league: `${item.gameweek}#${leagueId ?? 'unscoped'}`
  };
}

async function runExport(table) {
  console.log(`Scanning ${table}...`);
  const items = await scanAll(table);
  console.log(`Found ${items.length} items -- cross-check this against 'aws dynamodb describe-table --table-name ${table}''s ItemCount before deleting anything.`);

  const dataDir = `${__dirname}/data`;
  mkdirSync(dataDir, { recursive: true });
  const outPath = `${dataDir}/${table}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(outPath, JSON.stringify(items, null, 2));
  console.log(`Wrote backup to ${outPath}`);
}

async function runImport(table, filePath, dryRun) {
  const raw = readFileSync(filePath, 'utf8');
  const items = JSON.parse(raw);
  console.log(`Loaded ${items.length} items from ${filePath}`);

  const reshape = table === 'fpl_league_standings' ? reshapeStandingsItem : reshapeWinnersItem;
  const reshaped = items.map(reshape);

  console.log('Sample (first 3):');
  for (const item of reshaped.slice(0, 3)) {
    const keyField = table === 'fpl_league_standings' ? 'league_manager' : 'gameweek_league';
    console.log(`  ${keyField}=${item[keyField]}, league_id=${item.league_id}`);
  }

  if (dryRun) {
    console.log('\n--dry-run set -- nothing written.');
    return;
  }

  await batchWrite(table, reshaped);
  console.log(`Wrote ${reshaped.length} reshaped items into ${table}.`);
}

async function main() {
  const [, , mode, ...rest] = process.argv;
  const tableArg = rest.find((a) => a.startsWith('--table='))?.split('=')[1];
  const fileArg = rest.find((a) => a.startsWith('--file='))?.split('=')[1];
  const dryRun = rest.includes('--dry-run');

  if (!['export', 'import'].includes(mode) || !tableArg || !VALID_TABLES.includes(tableArg)) {
    console.error(
      'Usage:\n' +
      '  node scripts/migrate-composite-standings-key.mjs export --table=<fpl_league_standings|gw-winners-cache>\n' +
      '  node scripts/migrate-composite-standings-key.mjs import --table=<fpl_league_standings|gw-winners-cache> --file=<path> [--dry-run]'
    );
    process.exitCode = 1;
    return;
  }

  if (mode === 'export') {
    await runExport(tableArg);
  } else {
    if (!fileArg) {
      console.error('import mode requires --file=<path to exported backup json>');
      process.exitCode = 1;
      return;
    }
    await runImport(tableArg, fileArg, dryRun);
  }
}

main().catch((err) => {
  console.error('migrate-composite-standings-key failed:', err);
  process.exitCode = 1;
});
