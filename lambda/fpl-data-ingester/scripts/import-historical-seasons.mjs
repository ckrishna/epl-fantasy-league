// One-off import: backfills full Standings + GW Winners history for 2019/20 through
// 2024/25 from a manually-maintained export the league owner kept before this app
// existed (scripts/data/epl-historical-league-export.csv). Six seasons of complete
// per-manager, per-gameweek data -- overall rank, chip played, cumulative points,
// gameweek points, bench points, transfers, hit cost, team value.
//
// Seasons BEFORE 2019/20 (2010/11-2018/19) are deliberately excluded: the source file
// only has scattered single "final total" rows for those years, not full weekly
// standings -- not enough to reconstruct real GW-by-GW winners or rankings. See
// DATA_MODEL.md for the full writeup.
//
// WHAT THIS WRITES, and why it mirrors the live ingester exactly:
//   1. fpl_entry_gameweek -- one row per (manager, gameweek), same shape
//      lambda/fpl-data-ingester/index.mjs's storeGameweekSummary() writes for live
//      seasons, so every downstream reader (standings, winners, GenBI aggregates)
//      treats historical and live seasons identically without special-casing.
//   2. gw-winners-cache -- derived from the rows just written using the EXACT SAME
//      "highest net points (gross - transfer_cost) wins, ties share the win" logic as
//      index.mjs's own winner-calculation pass (lines ~378-420 there). Copied rather
//      than imported since index.mjs's version is inlined in a large function, not its
//      own exported unit -- if that ever changes, this should switch to importing it
//      instead of re-declaring the same logic.
//   3. fpl_league_standings -- one row per manager at the season's FINAL gameweek
//      (season_event = "{season}#{finalGW}"), matching what handleStandings() resolves
//      to when someone picks a past season from the dropdown (it walks back from the
//      latest stored gameweek, which will be the season finale here).
//   4. seasons -- one row per historical season so the season dropdown lists it at
//      all. Partition key is `season_id` (Number) -- confirmed against the AWS console
//      (Chetan checked the table's actual key schema, which also showed `season_id (N)`
//      is the same key used consistently across player_event_stats, players, teams,
//      etc.). season_string is still written as a regular attribute since every read
//      path (getAllSeasons, handleSeasons) uses it as the natural display/join value.
//
// DELIBERATELY NOT CAPTURED (decided with the league owner before writing this):
//   - Seasons before 2019/20 (see above).
//   - A team nickname per manager -- the source file only has each manager's real
//     name. `team_nickname` (renamed 2026-08-14 from the old, misleadingly-named
//     `manager_name` -- see DATA_MODEL.md's identity redesign notes) is left null for
//     every row this script writes; `real_name` (renamed from `team_name`) gets the
//     source file's name. Frontend (Standings.jsx, GWWinners.jsx) already skips
//     rendering the second, muted name line when team_nickname is null, so this shows
//     as a single name instead of a name + redundant/blank second line.
//
// entry_id: the source file has no real FPL entry ID, only names -- these managers'
// real FPL accounts may not even exist anymore. A stable, deterministic *negative*
// integer is derived from each normalized name (see stableEntryId below) so re-running
// this script is idempotent (same name always hashes to the same id, so writes
// overwrite instead of duplicating) and so historical synthetic IDs can never collide
// with a real positive FPL entry_id from a live season.
//
// Usage: node scripts/import-historical-seasons.mjs [path-to-csv]
//   Defaults to scripts/data/epl-historical-league-export.csv.
// Run locally (needs your AWS credentials; no network access to FPL needed -- this
// only reads the local CSV and writes to DynamoDB).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));

const CSV_PATH = process.argv[2] || join(__dirname, 'data', 'epl-historical-league-export.csv');

// Only these six -- see header comment for why earlier years are excluded.
const TARGET_SEASONS = ['2019/20', '2020/21', '2021/22', '2022/23', '2023/24', '2024/25'];

const CHIP_MAP = {
  wildcard: 'wildcard',
  'free hit': 'freehit',
  'bench boost': 'bboost',
  'triple captain': '3xc',
  'assistant manager': 'assistant_manager'
};

// ---- Minimal RFC4180 CSV parser -----------------------------------------------
// No CSV library is a dependency of this lambda (see package.json) and this is a
// one-off script, not worth adding one for. Handles the two things this file
// actually uses: quoted fields containing commas (e.g. "98,590") and a leading
// UTF-8 BOM on the header row.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const clean = text.startsWith('﻿') ? text.slice(1) : text;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

// Collapses ALL whitespace variants (including the non-breaking-space typos found in
// the source file -- e.g. "Chetan Bk" vs "Chetan Bk", same person, two spellings
// that would otherwise silently become two different "managers") to a single regular
// space, then trims. Every name comparison/grouping in this script goes through this
// first -- skipping it was the single easiest way to accidentally double-count a real
// person as two people.
function normName(raw) {
  return raw.replace(/[ \s]+/g, ' ').trim();
}

function normChip(raw) {
  const cleaned = raw.replace(/[ \s]+/g, ' ').trim().toLowerCase();
  if (!cleaned) return null;
  return CHIP_MAP[cleaned] || null;
}

function toNumber(raw, fallback = 0) {
  if (raw == null || raw === '') return fallback;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

// Deterministic, always-negative -- see the entry_id paragraph in the header comment.
function stableEntryId(name) {
  const hash = createHash('sha256').update(name).digest();
  const n = hash.readUInt32BE(0) % 900000000;
  return -(n + 100000000); // -[100000000, 999999999]
}

async function batchWrite(tableName, items) {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await dynamodb.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: chunk.map((Item) => ({ PutRequest: { Item } }))
      }
    }));
  }
}

async function importSeason(season, rowsForSeason) {
  console.log(`\n=== ${season}: ${rowsForSeason.length} source rows ===`);

  // name -> deterministic entry_id, so every row for the same person in this season
  // (and, since the hash is name-only, in EVERY season) uses the same synthetic id.
  const entryIdByName = new Map();
  for (const r of rowsForSeason) {
    const name = normName(r['﻿Name'] || r.Name);
    if (!entryIdByName.has(name)) entryIdByName.set(name, stableEntryId(name));
  }
  console.log(`Managers: ${[...entryIdByName.keys()].sort().join(', ')}`);

  const importedAt = new Date().toISOString();
  const gwRows = [];

  for (const r of rowsForSeason) {
    const name = normName(r['﻿Name'] || r.Name);
    const entryId = entryIdByName.get(name);
    const gameweek = toNumber(r.GW);
    if (!gameweek) continue; // guards against any stray blank/summary row slipping through

    gwRows.push({
      season_entry: `${season}#${entryId}`,
      gameweek,
      entry_id: entryId,
      season,
      team_nickname: null, // no historical team nickname -- see header comment
      real_name: name,
      points_this_week: toNumber(r.GP),
      points_gross: toNumber(r.GP),
      transfer_cost: toNumber(r.TC),
      points_total: toNumber(r.OP),
      transfers_made: toNumber(r.TM),
      transfers_remaining: null,
      active_chip: normChip(r['#'] || ''),
      bank: null,
      value: r['£'] ? toNumber(r['£'], null) : null,
      gw_winner: false, // set below, matching the live derivation's own two-pass approach
      last_synced: importedAt,
      data_version: 'v1',
      source: 'historical_csv_import'
    });
  }

  await batchWrite('fpl_entry_gameweek', gwRows);
  console.log(`Wrote ${gwRows.length} fpl_entry_gameweek rows.`);

  // ---- Derive GW winners -- identical rule to index.mjs's live derivation: highest
  // net points (gross - transfer_cost) for that gameweek; ties share the win. ----
  const byGw = new Map();
  for (const row of gwRows) {
    if (!byGw.has(row.gameweek)) byGw.set(row.gameweek, []);
    byGw.get(row.gameweek).push(row);
  }

  const winnerItems = [];
  for (const [gameweek, managersList] of byGw) {
    const maxNet = Math.max(...managersList.map((m) => m.points_this_week - m.transfer_cost));
    const winners = managersList.filter((m) => m.points_this_week - m.transfer_cost === maxNet);
    winnerItems.push({
      season,
      gameweek,
      winners: winners.map((w) => ({
        entry_id: w.entry_id,
        team_nickname: null, // no historical nickname -- match fpl_entry_gameweek/fpl_league_standings, not a duplicate of real_name
        real_name: w.real_name,
        net_points: w.points_this_week - w.transfer_cost,
        gross_points: w.points_this_week,
        transfer_cost: w.transfer_cost
      })),
      is_current: false,
      last_synced: importedAt,
      source: 'historical_csv_import'
    });
  }
  await batchWrite('gw-winners-cache', winnerItems);
  console.log(`Derived and wrote ${winnerItems.length} gw-winners-cache rows.`);

  // ---- Derive final standings: each manager's row at the season's LAST gameweek. ----
  const finalGw = Math.max(...gwRows.map((r) => r.gameweek));
  const latestByEntry = new Map();
  for (const row of gwRows) {
    const existing = latestByEntry.get(row.entry_id);
    if (!existing || row.gameweek > existing.gameweek) latestByEntry.set(row.entry_id, row);
  }

  const standingsItems = [...latestByEntry.values()].map((row) => ({
    season_event: `${season}#${finalGw}`,
    manager_id: row.entry_id,
    real_name: row.real_name,
    team_nickname: row.team_nickname,
    total_points: row.points_total,
    points_this_week: row.points_this_week,
    transfer_cost: row.transfer_cost,
    last_synced: importedAt,
    source: 'historical_csv_import'
  }));
  await batchWrite('fpl_league_standings', standingsItems);
  console.log(`Derived and wrote ${standingsItems.length} fpl_league_standings rows (final GW: ${finalGw}).`);

  return { managerCount: entryIdByName.size, gwRowCount: gwRows.length, finalGw };
}

async function main() {
  console.log(`Reading ${CSV_PATH}...`);
  const text = readFileSync(CSV_PATH, 'utf-8');
  const allRows = parseCsv(text);
  console.log(`Parsed ${allRows.length} total rows from source file.`);

  const summaries = [];

  // Chronological order for the seasons-table season_id assignment below -- must sort
  // BEFORE whatever the current/live seasons already use. Confirmed via the live
  // /seasons endpoint that 2025/26 and 2026/27 are the only rows there today; using
  // negative ids for every historical season guarantees no collision regardless of
  // their exact positive values, while still sorting these six correctly relative to
  // each other (getAllSeasons sorts descending by season_id). TARGET_SEASONS is
  // already oldest-first, so index 0 (2019/20) must get the MOST negative id and the
  // last index (2024/25) the LEAST negative -- i.e. -(length - idx), not -(idx + 1).
  for (const [idx, season] of TARGET_SEASONS.entries()) {
    const rowsForSeason = allRows.filter((r) => r.Season === season);
    if (rowsForSeason.length === 0) {
      console.warn(`No rows found for ${season} -- skipping.`);
      continue;
    }

    const summary = await importSeason(season, rowsForSeason);
    summaries.push({ season, ...summary });

    const seasonId = -(TARGET_SEASONS.length - idx); // 2019/20 -> -6, 2024/25 -> -1
    try {
      await dynamodb.send(new PutCommand({
        TableName: 'seasons',
        Item: {
          season_id: seasonId, // partition key (Number) -- confirmed via AWS console
          season_string: season,
          current: false,
          status: 'completed',
          league_id: null, // no historical league ID recorded -- header shows season only
          total_gameweeks: summary.finalGw,
          source: 'historical_csv_import'
        }
      }));
      console.log(`Wrote seasons row for ${season} (season_id ${seasonId}).`);
    } catch (err) {
      console.error(`FAILED to write seasons row for ${season} -- Standings/GW Winners data was still written and is valid, but this season won't appear in the season dropdown until this is fixed.`, err.message);
    }
  }

  console.log('\n=== Done ===');
  for (const s of summaries) {
    console.log(`  ${s.season}: ${s.managerCount} managers, ${s.gwRowCount} GW rows, final GW ${s.finalGw}`);
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
