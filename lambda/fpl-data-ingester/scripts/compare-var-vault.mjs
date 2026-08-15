// Read-only cross-check: compares our own stored 2025/26 data against the VAR Vault
// snapshot (scripts/data/manual-chip-totals-2025-26.json), which was captured live from
// FPL while 2025/26 was still current -- an independent source for exactly the kind of
// "does our schema/pipeline actually hold up" question raised earlier this session.
//
// Two comparisons, using data that was NEVER touched by the points/active_chip bugs
// fixed elsewhere (points_this_week and points_total come straight from
// entryHistory.points/entryHistory.total_points in storeGameweekSummary -- a different
// code path than the fpl_entry_picks.points bug, and not defaulted the way active_chip
// was):
//
//  1. GW-by-GW winner + net points, our gw-winners-cache vs VAR Vault's weekly_results.
//  2. Final season total points per manager, our fpl_entry_gameweek (highest points_total
//     seen per manager) vs VAR Vault's players[].total_points.
//
// This makes NO writes -- safe to run any time. Run locally (needs your AWS credentials,
// no FPL network access needed).
//
// Usage: node scripts/compare-var-vault.mjs [path-to-json] [season]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));

const JSON_PATH = process.argv[2] || join(__dirname, 'data', 'manual-chip-totals-2025-26.json');
const SEASON = process.argv[3] || '2025/26';

async function scanAll(tableName, filterExpr, values) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: filterExpr,
      ExpressionAttributeValues: values,
      ExclusiveStartKey: lastEvaluatedKey
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

async function main() {
  const source = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
  console.log(`Comparing against VAR Vault snapshot: "${source.league_name}" (${source.league_id}), updated_at ${source.updated_at}\n`);

  const [winnersRows, gwRows] = await Promise.all([
    scanAll('gw-winners-cache', 'season = :s', { ':s': SEASON }),
    scanAll('fpl_entry_gameweek', 'season = :s', { ':s': SEASON })
  ]);

  // ---- Comparison 1: GW-by-GW winners ----
  console.log('=== GW winners: ours (gw-winners-cache) vs VAR Vault (weekly_results) ===\n');

  const ourWinnersByGw = new Map();
  for (const row of winnersRows) {
    ourWinnersByGw.set(Number(row.gameweek), row.winners || []);
  }

  // VAR Vault can have multiple rows per gw (ties, like GW17) -- group them.
  const vaultByGw = new Map();
  for (const r of source.weekly_results || []) {
    if (!vaultByGw.has(r.gw)) vaultByGw.set(r.gw, []);
    vaultByGw.get(r.gw).push(r);
  }

  let gwMatches = 0;
  let gwMismatches = 0;
  let gwMissingOurs = 0;
  const mismatchDetails = [];

  const allGws = new Set([...ourWinnersByGw.keys(), ...vaultByGw.keys()]);
  for (const gw of Array.from(allGws).sort((a, b) => a - b)) {
    const ours = ourWinnersByGw.get(gw);
    const vault = vaultByGw.get(gw);

    if (!ours || ours.length === 0) {
      gwMissingOurs += 1;
      mismatchDetails.push(`GW${gw}: WE HAVE NO WINNER STORED. VAR Vault says: ${vault.map(v => `${v.name} (${v.points}pts)`).join(', ')}`);
      continue;
    }
    if (!vault) {
      mismatchDetails.push(`GW${gw}: we have a winner (${ours.map(w => w.real_name).join(', ')}) but VAR Vault has none -- source only covers GW1-${source.max_gameweek}.`);
      continue;
    }

    // Renamed 2026-08-14: real_name/team_nickname replace the old, misleadingly-named
    // team_name/manager_name (team_name used to hold the real person name, manager_name
    // the FPL squad nickname -- backwards from what they sounded like). VAR Vault's
    // "name" field is the real person name, so it matches our .real_name.
    const ourNames = new Set(ours.map(w => w.real_name));
    const vaultNames = new Set(vault.map(v => v.name));
    const namesMatch = ourNames.size === vaultNames.size && [...ourNames].every(n => vaultNames.has(n));

    // Compare points too (net_points is what determined our winner).
    const ourPoints = ours[0]?.net_points;
    const vaultPoints = vault[0]?.points;
    const pointsMatch = ourPoints === vaultPoints;

    if (namesMatch && pointsMatch) {
      gwMatches += 1;
    } else {
      gwMismatches += 1;
      mismatchDetails.push(
        `GW${gw}: MISMATCH -- ours: ${[...ourNames].join(', ')} (${ourPoints}pts) | ` +
        `VAR Vault: ${[...vaultNames].join(', ')} (${vaultPoints}pts)`
      );
    }
  }

  console.log(`Matches:              ${gwMatches}`);
  console.log(`Mismatches:           ${gwMismatches}`);
  console.log(`Missing from our DB:  ${gwMissingOurs}`);
  if (mismatchDetails.length > 0) {
    console.log('\nDetails:');
    mismatchDetails.forEach(d => console.log(`  ${d}`));
  }

  // ---- Comparison 2: season total points per manager ----
  console.log('\n=== Season total points: ours (max points_total seen) vs VAR Vault (players[].total_points) ===\n');

  const ourTotalByName = new Map();
  for (const row of gwRows) {
    // Same rename note as above: .real_name holds the real person name, which is what
    // VAR Vault's players[].name matches against.
    const name = row.real_name;
    if (!name) continue;
    const total = Number(row.points_total || 0);
    if (!ourTotalByName.has(name) || total > ourTotalByName.get(name)) {
      ourTotalByName.set(name, total);
    }
  }

  let totalMatches = 0;
  let totalMismatches = 0;
  const totalDetails = [];

  for (const player of source.players || []) {
    const ourTotal = ourTotalByName.get(player.name);
    if (ourTotal === undefined) {
      totalDetails.push(`${player.name}: NOT FOUND in our fpl_entry_gameweek data.`);
      totalMismatches += 1;
      continue;
    }
    if (ourTotal === player.total_points) {
      totalMatches += 1;
    } else {
      totalMismatches += 1;
      totalDetails.push(`${player.name}: ours=${ourTotal} vs VAR Vault=${player.total_points} (diff ${ourTotal - player.total_points})`);
    }
  }

  console.log(`Matches:    ${totalMatches}`);
  console.log(`Mismatches: ${totalMismatches}`);
  if (totalDetails.length > 0) {
    console.log('\nDetails:');
    totalDetails.forEach(d => console.log(`  ${d}`));
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Comparison failed:', err);
  process.exit(1);
});
