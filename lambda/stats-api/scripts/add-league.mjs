// CLI to validate and register a new league in the `leagues` table.
//
// Usage:
//   node scripts/add-league.mjs <league_id> [league_group_id]
//
// league_group_id is optional at registration time -- it's the value that links this
// league_id to the SAME recurring group of managers across seasons (needed because FPL
// issues a new league_id every season -- see DATA_MODEL.md). If this is the first time
// onboarding this group, leave it off; a group id can be set/edited later directly in
// the `leagues` table since nothing at registration time depends on it existing yet.
//
// This script only registers the league (writes one row to `leagues`). It does NOT pull
// any picks/standings/gameweek data -- that's the mid-season backfill step, tracked
// separately (see the multi-league GitHub issue), and is intentionally kept out of this
// script so a bad backfill run can't be entangled with the registration decision.
//
// Requires real AWS credentials with DynamoDB read/write access to `leagues` and
// `seasons` (read-only), and no other tables.

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from '../utils/dynamodb.mjs';
import { validateLeagueForOnboarding } from '../utils/league-validation.mjs';

async function main() {
  const [, , leagueIdArg, leagueGroupIdArg] = process.argv;
  if (!leagueIdArg) {
    console.error('Usage: node scripts/add-league.mjs <league_id> [league_group_id]');
    process.exitCode = 1;
    return;
  }

  console.log(`Checking league ${leagueIdArg}...`);
  const result = await validateLeagueForOnboarding(leagueIdArg);

  if (result.league) {
    console.log(`\nFound: "${result.league.name}" (id ${result.league.id})`);
    console.log(`  created:  ${result.league.created}`);
    console.log(`  entries:  ${result.league.entryCount}`);
    console.log(`  season:   ${result.league.season}`);
  }

  if (!result.ok) {
    console.log(`\nNOT registered -- ${result.errors.length} check(s) failed:`);
    for (const e of result.errors) console.log(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll checks passed.`);
  console.log(`Double-check the name/entry count above is actually the league you meant --`);
  console.log(`FPL recycles league ids across seasons, so a stale id resolves to some OTHER`);
  console.log(`real league rather than failing (see league-validation.mjs for details).`);

  await dynamodb.send(new PutCommand({
    TableName: 'leagues',
    Item: {
      league_id: result.league.id,
      season_string: result.league.season,
      league_group_id: leagueGroupIdArg || null,
      name: result.league.name,
      entry_count: result.league.entryCount,
      status: 'active',
      added_at: new Date().toISOString()
    }
  }));

  console.log(`\nRegistered league ${result.league.id} for ${result.league.season}.`);
  if (!leagueGroupIdArg) {
    console.log(`No league_group_id set -- add one later if this group continues into another season.`);
  }
  console.log(`\nNext: run the mid-season backfill for this league before it appears anywhere`);
  console.log(`in the app (not yet built -- see the multi-league GitHub issue for scope).`);
}

main().catch((err) => {
  console.error('add-league failed:', err);
  process.exitCode = 1;
});
