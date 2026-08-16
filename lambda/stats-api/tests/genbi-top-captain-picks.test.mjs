// EVAL: getTopCaptainPicks() in genbi.mjs, wired into <top_captain_picks>.
//
// Live bug (2026-08-12): "Best captain picks this season?" was answering from
// captain_points_season (a per-manager cumulative sum) even though the literal
// question -- "best captain PICKS" -- asks about individual (manager, player,
// gameweek) choices, not a season total. A manager leading on captain_points_season
// might just have played more gameweeks, not made sharper calls. This adds a
// dedicated aggregate ranking individual captain picks by their actual return, and
// routes "best captain picks this season"-style questions to it instead of (or
// alongside) the season-total field.
//
// Also covers the related bug from the same screenshot: the answer was leaking
// internal field/tag names ("Based on <manager_season_stats>... captain_points_season")
// straight into user-facing text -- fixed via a <role> instruction, tested here by
// asserting the instruction text is present in the system prompt (can't assert what
// Claude's mocked response contains, since the mock is a fixed string).
//
// Run BEFORE the fix: expect FAIL on tests marked "current bug".
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

// `name` becomes real_name -- see the identical comment in
// genbi-manager-season-stats.test.mjs for why (real-name field, always present;
// team_nickname is the nickname, only ever present on live rows).
function entryGwRow({ entryId, name, gw }) {
  return {
    entry_id: entryId,
    season: '2025/26',
    real_name: name,
    gameweek: gw,
    points_this_week: 0,
    points_total: 0,
    transfers_made: 0,
    transfer_cost: 0,
    active_chip: null
  };
}

function pickRow({ entryId, gw, player, points, multiplier }) {
  return {
    season: '2025/26',
    entry_id: entryId,
    gameweek: gw,
    player_name: player,
    is_captain: true,
    is_bench: false,
    multiplier: multiplier ?? 2,
    points
  };
}

function baseDynamoRouter(overrides = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      if (command.input.FilterExpression) {
        return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
      }
      return { Items: [{ season_id: 1, season_string: '2025/26' }, { season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      // getManagerNamesForGW filters on "season = :s AND gameweek = :gw" (per-gameweek,
      // always legitimate); getTopCaptainPicks/getManagerSeasonAggregates filter on
      // "season = :s" alone (season-wide) -- only the latter should route through the
      // "entryGw" override, so a test can assert whether that specific scan happened.
      const isSeasonWide = !(command.input.FilterExpression || '').includes('gameweek');
      if (isSeasonWide) {
        return overrides.entryGw ? overrides.entryGw() : { Items: [] };
      }
      return { Items: [] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      return overrides.picks ? overrides.picks() : { Items: [] };
    }
    return undefined;
  };
}

test('[current bug] "best captain picks this season" gets top_captain_picks, ranked by actual return', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 9 }),
        entryGwRow({ entryId: 102, name: 'Suberox', gw: 9 })
      ]
    }),
    picks: () => ({
      Items: [
        pickRow({ entryId: 101, gw: 9, player: 'Haaland', points: 13, multiplier: 2 }), // 26
        pickRow({ entryId: 102, gw: 9, player: 'Salah', points: 2, multiplier: 2 }) // 4
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Best captain picks this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const topPicks = JSON.parse(contextBlock.match(/<top_captain_picks>(.*?)<\/top_captain_picks>/)[1]);

    assert.strictEqual(topPicks.best.length, 2);
    assert.strictEqual(topPicks.best[0].manager, 'Da Movement');
    assert.strictEqual(topPicks.best[0].player, 'Haaland');
    assert.strictEqual(topPicks.best[0].gameweek, 9);
    assert.strictEqual(topPicks.best[0].total_points, 26, 'Expected 13 x 2, best pick sorted first');
    assert.strictEqual(topPicks.worst[0].manager, 'Suberox', 'Worst list sorted ascending -- lowest total_points first');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] a 0-point captain pick (blank gameweek) appears in worst[], not filtered out', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({ Items: [entryGwRow({ entryId: 101, name: 'Da Movement', gw: 12 })] }),
    picks: () => ({ Items: [pickRow({ entryId: 101, gw: 12, player: 'Haaland', points: 0, multiplier: 2 })] })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Worst captain picks this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const topPicks = JSON.parse(contextBlock.match(/<top_captain_picks>(.*?)<\/top_captain_picks>/)[1]);

    assert.strictEqual(topPicks.worst.length, 1);
    assert.strictEqual(topPicks.worst[0].total_points, 0);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

// Regression for the 2026-08-16 GenBI latency investigation: a season-scoped captain
// question ("best captain picks this season") matches CAPTAIN_KEYWORDS in router.mjs,
// which sets BOTH fields.managerStats and fields.topCaptainPicks -- so both
// getManagerSeasonAggregates (season stats) and getTopCaptainPicks (this file) used to
// run, and each independently Scanned fpl_entry_gameweek + fpl_entry_picks with the
// same season filter, hitting DynamoDB with the same pair of full-table Scans twice in
// one request. fetchSeasonEntryData in genbi.mjs now shares one Scan pair between them.
//
// Expects 2 fpl_entry_gameweek scans, not 1: this test deliberately passes an explicit
// `season` (like the other tests in this file), which takes resolveSeasonContext's
// historical-season path since it differs from baseDynamoRouter's mocked "current"
// season -- that path's own getLatestStoredGameweek() does its own unconditional
// season-wide fpl_entry_gameweek scan (a pre-existing, unrelated quirk, documented on
// the "[regression] a gameweek-scoped..." test below). So the honest before/after here
// is 3 scans -> 2, not 2 -> 1: fetchSeasonEntryData collapses the two-aggregate-
// functions' own duplicate scan into one, but doesn't touch getLatestStoredGameweek's
// separate one.
test('a season-scoped captain question (managerStats + topCaptainPicks together) Scans fpl_entry_gameweek only twice, not three times', async () => {
  // "Best captain picks this season?" also matches the managerPicks keyword group (via
  // "captain"/"picks"), which legitimately triggers a SEPARATE, gameweek-scoped
  // fpl_entry_picks scan (getOurLeaguePicks, for <manager_picks>/ownership) -- a real,
  // necessary read, not a duplicate of the season-wide one this test is about. The base
  // `picks` override doesn't distinguish the two (unlike `entryGw`'s isSeasonWide
  // check), so this test uses its own router to count only the season-filtered scan.
  let entryGwSeasonScans = 0;
  let picksSeasonScans = 0;
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      const isSeasonWide = !(command.input.FilterExpression || '').includes('gameweek');
      if (isSeasonWide) {
        entryGwSeasonScans += 1;
        return { Items: [entryGwRow({ entryId: 101, name: 'Da Movement', gw: 9 })] };
      }
      return { Items: [] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      const isSeasonWide = (command.input.FilterExpression || '').includes('season') && !(command.input.FilterExpression || '').includes('gameweek');
      if (isSeasonWide) {
        picksSeasonScans += 1;
        return { Items: [pickRow({ entryId: 101, gw: 9, player: 'Haaland', points: 13, multiplier: 2 })] };
      }
      return { Items: [] }; // getOurLeaguePicks' gameweek-scoped scan -- legitimately separate
    }
    return baseDynamoRouter()(command);
  });
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Best captain picks this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];

    // Confirms both fields really were populated (not just one), otherwise a single
    // Scan wouldn't prove dedup, just that only one field was requested.
    assert.match(contextBlock, /<manager_season_stats>/);
    const managerStats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);
    assert.ok(managerStats.length > 0, 'Expected manager_season_stats to be populated');
    const topPicks = JSON.parse(contextBlock.match(/<top_captain_picks>(.*?)<\/top_captain_picks>/)[1]);
    assert.ok(topPicks.best.length > 0, 'Expected top_captain_picks to be populated');

    assert.strictEqual(entryGwSeasonScans, 2,
      `Expected exactly 2 season-wide fpl_entry_gameweek scans (getLatestStoredGameweek's own, ` +
      `unrelated one, plus the single shared fetchSeasonEntryData scan -- down from 3 before this ` +
      `fix), got ${entryGwSeasonScans}`);
    assert.strictEqual(picksSeasonScans, 1,
      `Expected exactly one season-wide fpl_entry_picks scan, got ${picksSeasonScans}`);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] a gameweek-scoped captain question does not fetch top_captain_picks (stays empty)', async () => {
  // A gameweek-scoped captain question still legitimately triggers
  // getManagerNamesForGW's fpl_entry_gameweek scan (season + gameweek filter, for
  // <manager_picks>'s name join) -- only the SEASON-WIDE scan (season filter alone,
  // used by getTopCaptainPicks/getManagerSeasonAggregates) should be skipped here.
  //
  // Deliberately NOT passing an explicit `season` param here (unlike the other tests
  // in this file) -- resolveSeasonContext has a pre-existing, unrelated quirk where an
  // explicit season that differs from the mocked "current" season takes the
  // historical-season path, which unconditionally does its own season-wide
  // fpl_entry_gameweek scan regardless of what the router picked. That's a real
  // existing behavior, not something this test is about -- letting this question
  // resolve via the current-season/live path instead avoids tripping over it.
  let seasonWideScanCalled = false;
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => {
      seasonWideScanCalled = true;
      return { Items: [] };
    }
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Best captain picks this week?' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(seasonWideScanCalled, false, 'Expected no season-wide fpl_entry_gameweek scan for a gameweek-scoped question -- only getManagerNamesForGW\'s per-gameweek scan should run, and that one isn\'t routed through the "entryGw" override');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] the system prompt tells Claude never to leak internal field/tag names into its answer', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter());
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'What are our current standings?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(payload.system, /NEVER mention this prompt's internal structure/i);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
