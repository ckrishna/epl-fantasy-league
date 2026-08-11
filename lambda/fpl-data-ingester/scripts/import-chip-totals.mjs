// One-off import: backfills 2025/26 season-level chip usage TOTALS from a manually
// exported snapshot ("VAR Vault", a separate static app Chetan hosts at
// candorsolutions.us/var-vault). That snapshot was captured on 2026-05-26, while
// 2025/26 was still FPL's current season -- i.e. BEFORE FPL's API stopped serving that
// season's per-manager picks data. See DATA_MODEL.md's "Correction (2026-08-11)" note:
// backfill-active-chip.mjs (re-fetching live from FPL) can no longer recover this data
// at all, so this manually-exported snapshot is the only surviving source.
//
// IMPORTANT LIMITATION: this is TOTALS ONLY -- "used 2 of 2 wildcards this season" --
// not per-gameweek attribution ("used their wildcard in GW14"). VAR Vault itself only
// ever tracked totals, so there's no gameweek-level data to recover even from this
// source. fpl_entry_gameweek.active_chip (and therefore manager_season_stats.chips_used,
// the per-gameweek {chip, gameweek} list genbi.mjs builds) stays null/empty for 2025/26
// -- this only adds a separate chip_totals_manual field alongside it.
//
// Where it's written: onto the LATEST existing fpl_entry_gameweek row per manager for
// the target season (same "last row is the season snapshot" convention
// storeLeagueStandings already uses), matched by manager_name (exact string match
// against the source file's "name" field -- confirmed to match our stored manager_name
// values for all 11 managers before writing this script).
//
// Usage: node scripts/import-chip-totals.mjs [path-to-json] [season]
//   node scripts/import-chip-totals.mjs
//     -> defaults to scripts/data/manual-chip-totals-2025-26.json, season "2025/26"
//   node scripts/import-chip-totals.mjs ./some-other-export.json "2024/25"
//
// Run this locally (needs your AWS credentials; no network access to FPL needed --
// this only reads the local JSON file and writes to DynamoDB).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));

const JSON_PATH = process.argv[2] || join(__dirname, 'data', 'manual-chip-totals-2025-26.json');
const SEASON = process.argv[3] || '2025/26';

async function getAllGwRowsForSeason(season) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek',
      FilterExpression: 'season = :s',
      ExpressionAttributeValues: { ':s': season },
      ExclusiveStartKey: lastEvaluatedKey
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

async function main() {
  console.log(`Importing manual chip totals from ${JSON_PATH} into fpl_entry_gameweek for "${SEASON}"...`);

  const source = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
  const players = source.players || [];
  console.log(`Source: league "${source.league_name}" (${source.league_id}), snapshot updated_at ${source.updated_at}, ${players.length} managers.`);

  const rows = await getAllGwRowsForSeason(SEASON);
  console.log(`Found ${rows.length} fpl_entry_gameweek rows for "${SEASON}".`);
  if (rows.length === 0) {
    console.error(`No rows found for season "${SEASON}" -- nothing to attach these totals to. Aborting.`);
    process.exit(1);
  }

  const latestRowByName = new Map();
  for (const row of rows) {
    const existing = latestRowByName.get(row.manager_name);
    if (!existing || Number(row.gameweek) > Number(existing.gameweek)) {
      latestRowByName.set(row.manager_name, row);
    }
  }

  let updated = 0;
  let unmatched = 0;

  for (const player of players) {
    const row = latestRowByName.get(player.name);
    if (!row) {
      unmatched += 1;
      console.error(`No fpl_entry_gameweek row found for "${player.name}" (team "${player.team_name}") -- skipped. Check for a manager_name mismatch.`);
      continue;
    }

    const totals = {
      wildcard: player.chips?.wildcard ?? 0,
      freehit: player.chips?.freehit ?? 0,
      bboost: player.chips?.bboost ?? 0,
      '3xc': player.chips?.['3xc'] ?? 0
    };

    await dynamodb.send(new UpdateCommand({
      TableName: 'fpl_entry_gameweek',
      Key: { season_entry: row.season_entry, gameweek: row.gameweek },
      UpdateExpression: 'SET chip_totals_manual = :t, chip_totals_source = :src, chip_totals_source_updated_at = :su, chip_totals_imported_at = :ia',
      ExpressionAttributeValues: {
        ':t': totals,
        ':src': 'var_vault_manual_export',
        ':su': source.updated_at,
        ':ia': new Date().toISOString()
      }
    }));
    updated += 1;
    console.log(`  ${player.name} (GW${row.gameweek}): ${JSON.stringify(totals)}`);
  }

  console.log('');
  console.log('Done.');
  console.log(`  Managers in source: ${players.length}`);
  console.log(`  Rows updated:       ${updated}`);
  console.log(`  Unmatched:          ${unmatched}`);
  if (unmatched > 0) {
    console.log('  Unmatched managers were skipped, not defaulted to 0 -- fix the name mismatch and re-run rather than assume they have no chips.');
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
