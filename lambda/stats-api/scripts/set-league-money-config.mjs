// Sets (or updates) a league group's real-money prize-pool config -- buy-in, per-GW
// payout, season-end top-N split, and the last-place-forgiveness threshold. See
// DATA_MODEL.md's "League money config" section and src/utils/leagueFinances.js on the
// frontend, which is what actually computes each manager's running net from whatever
// this writes.
//
// Deliberately opt-in and per-league: writes plain attributes onto an EXISTING `groups`
// row (no new table -- see utils/group-seasons.mjs's getMoneyConfigForLeagueId, which
// only ever returns non-null when money_enabled is explicitly true on that row). A
// league that's never had this script run against it is completely unaffected --
// standings.mjs's money_config comes back null and the frontend renders nothing.
//
// Usage:
//   node scripts/set-league-money-config.mjs --group-id carpe-diem \
//     --buy-in 30 --gw-payout 5 --top-splits 70,30,10 --last-place-min-wins 2 \
//     [--total-gameweeks 38] [--dry-run]
//   node scripts/set-league-money-config.mjs --group-id carpe-diem --disable [--dry-run]
//
//   --group-id            required. The slug printed by seed-default-group.mjs (must
//                          already exist -- this script does NOT create a group).
//   --buy-in               dollars per manager, required unless --disable.
//   --gw-payout             dollars split among each gameweek's winner(s), required
//                          unless --disable.
//   --top-splits            comma-separated weights for the season-end top-N payout,
//                          e.g. "70,30,10" -- these are WEIGHTS normalized by their own
//                          sum, not literal percentages (see leagueFinances.js's own
//                          comment: a 10-member league's $110 overall pot pays exactly
//                          $70/$30/$10 because 70+30+10=110, not 100). Required unless
//                          --disable.
//   --last-place-min-wins   optional, default 0 (rule off). If set to N>0: whoever's
//                          LAST in the standings forfeits ALL their GW winnings unless
//                          they won at least N gameweeks outright -- each forfeited
//                          week gets reassigned to that week's own runner-up (ties
//                          split evenly), not held back. The confirmed real rule for
//                          Carpe Diem is 2 ("more than one win to keep it").
//   --total-gameweeks       optional, default 38 (standard EPL season). The FULL season
//                          length, used to size the season-end top-N pot -- deliberately
//                          NOT however many gameweeks have been played so far (see
//                          leagueFinances.js's header comment: using games-played-so-far
//                          was an actual bug, caught live 2026-08-16, that made a single
//                          gameweek's standings look like they were worth almost the
//                          entire season's pot).
//   --disable               turns money_enabled off without needing to also repeat the
//                          dollar amounts -- keeps them on the row untouched (so
//                          re-enabling later doesn't require re-typing everything).
//   --dry-run               prints what would be written without writing anything.
//
// Requires AWS credentials with read/write access to `groups`.

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from '../utils/dynamodb.mjs';

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const disable = argv.includes('--disable');
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
  };
  return {
    dryRun,
    disable,
    groupId: flag('--group-id'),
    buyIn: flag('--buy-in'),
    gwPayout: flag('--gw-payout'),
    topSplits: flag('--top-splits'),
    lastPlaceMinWins: flag('--last-place-min-wins'),
    totalGameweeks: flag('--total-gameweeks')
  };
}

function printUsage() {
  console.error('Usage: node scripts/set-league-money-config.mjs --group-id <id> --buy-in <n> --gw-payout <n> --top-splits <n,n,n> [--last-place-min-wins <n>] [--total-gameweeks <n>] [--dry-run]');
  console.error('   or: node scripts/set-league-money-config.mjs --group-id <id> --disable [--dry-run]');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.groupId) {
    console.error('--group-id is required.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(`Checking group "${args.groupId}" exists...`);
  const existing = await dynamodb.send(new GetCommand({ TableName: 'groups', Key: { group_id: args.groupId } }));
  if (!existing.Item) {
    console.error(`No "groups" row for group_id "${args.groupId}". Run seed-default-group.mjs first.`);
    process.exitCode = 1;
    return;
  }

  if (args.disable) {
    console.log(`Disabling money config for "${args.groupId}" (dollar amounts left as-is)...`);
    if (args.dryRun) {
      console.log('--dry-run set -- nothing written.');
      return;
    }
    await dynamodb.send(new UpdateCommand({
      TableName: 'groups',
      Key: { group_id: args.groupId },
      UpdateExpression: 'SET money_enabled = :false',
      ExpressionAttributeValues: { ':false': false }
    }));
    console.log('Done.');
    return;
  }

  if (!args.buyIn || !args.gwPayout || !args.topSplits) {
    console.error('--buy-in, --gw-payout, and --top-splits are all required (unless using --disable).');
    printUsage();
    process.exitCode = 1;
    return;
  }

  const buyIn = Number(args.buyIn);
  const gwPayout = Number(args.gwPayout);
  const topSplits = args.topSplits.split(',').map((s) => Number(s.trim()));
  const lastPlaceMinWins = args.lastPlaceMinWins != null ? Number(args.lastPlaceMinWins) : 0;
  const totalGameweeks = args.totalGameweeks != null ? Number(args.totalGameweeks) : 38;

  if (!(buyIn > 0)) {
    console.error(`--buy-in must be a positive number, got "${args.buyIn}".`);
    process.exitCode = 1;
    return;
  }
  if (!(gwPayout >= 0)) {
    console.error(`--gw-payout must be a non-negative number, got "${args.gwPayout}".`);
    process.exitCode = 1;
    return;
  }
  if (topSplits.length === 0 || topSplits.some((n) => !(n > 0) || Number.isNaN(n))) {
    console.error(`--top-splits must be a comma-separated list of positive numbers, got "${args.topSplits}".`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(lastPlaceMinWins) || lastPlaceMinWins < 0) {
    console.error(`--last-place-min-wins must be a non-negative integer, got "${args.lastPlaceMinWins}".`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(totalGameweeks) || totalGameweeks <= 0) {
    console.error(`--total-gameweeks must be a positive integer, got "${args.totalGameweeks}".`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nWriting money config for "${args.groupId}":`);
  console.log(`  buy_in: $${buyIn}`);
  console.log(`  gw_payout: $${gwPayout}`);
  console.log(`  top_splits: [${topSplits.join(', ')}]  (weights, normalized by their own sum -- not literal percentages)`);
  console.log(`  last_place_min_wins_to_keep: ${lastPlaceMinWins}${lastPlaceMinWins === 0 ? '  (rule off)' : ''}`);
  console.log(`  total_gameweeks: ${totalGameweeks}`);
  console.log('  money_enabled: true');

  if (args.dryRun) {
    console.log('\n--dry-run set -- nothing written.');
    return;
  }

  await dynamodb.send(new UpdateCommand({
    TableName: 'groups',
    Key: { group_id: args.groupId },
    UpdateExpression: 'SET buy_in = :buyIn, gw_payout = :gwPayout, top_splits = :topSplits, last_place_min_wins_to_keep = :lastPlaceMinWins, total_gameweeks = :totalGameweeks, money_enabled = :enabled',
    ExpressionAttributeValues: {
      ':buyIn': buyIn,
      ':gwPayout': gwPayout,
      ':topSplits': topSplits,
      ':lastPlaceMinWins': lastPlaceMinWins,
      ':totalGameweeks': totalGameweeks,
      ':enabled': true
    }
  }));
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('set-league-money-config failed:', err);
  process.exitCode = 1;
});
