// One-off backfill: populates the player_season_totals table with FPL's own
// authoritative season-total points for a completed past season, sourced from each
// current player's `history_past` entry (element-summary API).
//
// Why this exists: our own weekly ingestion (fpl-global-stats-weekly) has confirmed
// gaps for some historical gameweeks (e.g. 2025/26 GW31 and GW34 are each missing
// roughly 150-250 players' rows), which undercounts anyone caught in those gaps when
// GenBI sums player_event_stats itself. FPL's history_past field gives an authoritative
// season total straight from FPL, unaffected by our own ingestion gaps.
//
// Limitation: only covers players still in FPL's CURRENT player pool -- element IDs are
// reassigned every season, so there's no way to query element-summary for someone no
// longer in this season's ~600-700 player list (e.g. players from relegated teams, or
// who've retired/left the Premier League since). Season totals for anyone who's left
// will still fall back to our own (potentially gappy) live aggregation.
//
// Usage: node scripts/backfill-season-totals.mjs [season_name]
//   node scripts/backfill-season-totals.mjs           -> defaults to "2025/26"
//   node scripts/backfill-season-totals.mjs "2024/25" -> backfill a different season
//
// Run this locally (needs your AWS credentials + network access to fantasy.premierleague.com).
// Takes a few minutes -- one HTTP call per current player (~600-700), rate-limited.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const FPL_API = 'https://fantasy.premierleague.com/api';
const TARGET_SEASON = process.argv[2] || '2025/26';

async function getBootstrap() {
  const res = await fetch(`${FPL_API}/bootstrap-static/`);
  if (!res.ok) throw new Error(`bootstrap-static HTTP ${res.status}`);
  return res.json();
}

async function getElementSummary(playerId) {
  const res = await fetch(`${FPL_API}/element-summary/${playerId}/`);
  if (!res.ok) throw new Error(`element-summary/${playerId} HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`Backfilling authoritative season totals for "${TARGET_SEASON}"...`);

  const bootstrap = await getBootstrap();
  const teamMap = {};
  for (const team of bootstrap.teams) {
    teamMap[team.id] = team.name;
  }

  const players = bootstrap.elements;
  console.log(`Found ${players.length} players in the current player pool.`);

  let found = 0;
  let written = 0;
  let notInSeason = 0;
  let errors = 0;

  for (let i = 0; i < players.length; i++) {
    const player = players[i];

    if (i % 50 === 0) {
      console.log(`Progress: ${i}/${players.length} (found=${found}, written=${written}, errors=${errors})`);
    }

    try {
      const summary = await getElementSummary(player.id);
      const pastEntry = (summary.history_past || []).find((h) => h.season_name === TARGET_SEASON);

      if (!pastEntry) {
        notInSeason += 1;
        continue;
      }

      found += 1;

      await dynamodb.send(new PutCommand({
        TableName: 'player_season_totals',
        Item: {
          season_string: TARGET_SEASON,
          player_name: player.web_name,
          team_name: teamMap[player.team] || 'Unknown Team', // current team -- may differ from their team during the target season if they've since transferred
          total_points: pastEntry.total_points,
          minutes: pastEntry.minutes,
          goals_scored: pastEntry.goals_scored,
          assists: pastEntry.assists,
          element_code: player.code,
          last_synced: new Date().toISOString()
        }
      }));
      written += 1;
    } catch (err) {
      errors += 1;
      console.error(`Failed for player ${player.id} (${player.web_name}): ${err.message}`);
    }

    // Be polite to FPL's API -- same rate-limit pattern already used by
    // fpl-global-stats-weekly/index.mjs.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log('');
  console.log('Done.');
  console.log(`  Players checked:      ${players.length}`);
  console.log(`  Had a "${TARGET_SEASON}" entry: ${found}`);
  console.log(`  Written to DynamoDB:  ${written}`);
  console.log(`  No entry for season:  ${notInSeason} (likely joined the PL after ${TARGET_SEASON})`);
  console.log(`  Errors:               ${errors}`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
