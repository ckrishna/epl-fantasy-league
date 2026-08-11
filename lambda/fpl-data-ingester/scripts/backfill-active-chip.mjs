// One-off backfill: fixes fpl_entry_gameweek.active_chip for a completed past season.
//
// Why this exists: storeGameweekSummary() in index.mjs read `entryHistory.active_chip`,
// but FPL's real /entry/{id}/event/{gw}/picks/ response has active_chip at the TOP
// LEVEL of the response, not nested inside entry_history. entryHistory.active_chip was
// therefore always undefined, silently masked by `|| null`. Confirmed live: a scan of
// all 396 existing fpl_entry_gameweek rows for 2025/26 found zero non-null active_chip
// values -- not plausible across 11 managers and up to 38 gameweeks each. index.mjs is
// now fixed to read the correct top-level field going forward.
//
// Unlike the fpl_entry_picks.points bug, this data is NOT lost -- it's not FPL's
// season-bound /event/{gw}/live/ endpoint (which stops serving old seasons once a new
// one starts), it's each manager's own historical picks record
// (/entry/{id}/event/{gw}/picks/), which FPL keeps accessible indefinitely (the same
// way you can browse your own past-season gameweek history in the app). So this
// re-fetches from FPL directly, one call per (entry_id, gameweek) row that already
// exists in fpl_entry_gameweek for the target season.
//
// Usage: node scripts/backfill-active-chip.mjs [season_name]
//   node scripts/backfill-active-chip.mjs           -> defaults to "2025/26"
//   node scripts/backfill-active-chip.mjs "2024/25" -> backfill a different season
//
// Run this locally (needs your AWS credentials + network access to
// fantasy.premierleague.com). ~396 rows at a rate-limited ~200ms/request -> a couple of
// minutes.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const FPL_API = 'https://fantasy.premierleague.com/api';
const TARGET_SEASON = process.argv[2] || '2025/26';
const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function getAllGwRowsForSeason(seasonString) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek',
      FilterExpression: 'season = :s',
      ExpressionAttributeValues: { ':s': seasonString },
      ExclusiveStartKey: lastEvaluatedKey
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

async function getActiveChip(entryId, gw) {
  const res = await fetch(`${FPL_API}/entry/${entryId}/event/${gw}/picks/`, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.active_chip ?? null;
}

async function main() {
  console.log(`Backfilling fpl_entry_gameweek.active_chip for "${TARGET_SEASON}"...`);

  const rows = await getAllGwRowsForSeason(TARGET_SEASON);
  console.log(`Found ${rows.length} fpl_entry_gameweek rows for "${TARGET_SEASON}".`);

  let checked = 0;
  let chipsFound = 0;
  let updated = 0;
  let errors = 0;
  const chipsSample = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (i % 50 === 0) {
      console.log(`Progress: ${i}/${rows.length} (chips_found=${chipsFound}, updated=${updated}, errors=${errors})`);
    }

    try {
      const activeChip = await getActiveChip(row.entry_id, row.gameweek);
      checked += 1;

      if (activeChip) {
        chipsFound += 1;
        if (chipsSample.length < 15) {
          chipsSample.push(`${row.manager_name} GW${row.gameweek}: ${activeChip}`);
        }
      }

      // Only write if the real value differs from what's stored -- avoids a pointless
      // write for the (majority) case where null was actually correct all along.
      if (activeChip !== (row.active_chip ?? null)) {
        await dynamodb.send(new UpdateCommand({
          TableName: 'fpl_entry_gameweek',
          Key: { season_entry: row.season_entry, gameweek: row.gameweek },
          UpdateExpression: 'SET active_chip = :c, active_chip_backfilled = :b, last_synced = :ls',
          ExpressionAttributeValues: {
            ':c': activeChip,
            ':b': true,
            ':ls': new Date().toISOString()
          }
        }));
        updated += 1;
      }
    } catch (err) {
      errors += 1;
      console.error(`Failed for ${row.manager_name} GW${row.gameweek} (entry_id=${row.entry_id}): ${err.message}`);
    }

    // Be polite to FPL's API -- same rate-limit pattern already used elsewhere in this
    // project (fpl-global-stats-weekly, backfill-season-totals.mjs).
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log('');
  console.log('Done.');
  console.log(`  Rows checked:       ${checked}`);
  console.log(`  Real chips found:   ${chipsFound}`);
  console.log(`  Rows updated:       ${updated}`);
  console.log(`  Errors:             ${errors}`);
  if (chipsSample.length > 0) {
    console.log(`  Sample chips found: ${chipsSample.join('; ')}`);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
