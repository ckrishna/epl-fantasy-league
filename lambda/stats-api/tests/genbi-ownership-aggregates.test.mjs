// EVAL: our_league_picks team_nickname bugfix + #39 Phase 2 ownership aggregates
// (handlers/genbi.mjs's getManagerNamesForGW / computeOwnershipAggregates, wired into
// our_league_picks and ownership_aggregates).
//
// Background: fpl_entry_picks rows never carry a team_nickname field (confirmed against
// fpl-data-ingester's storePicks() write -- only entry_id). The pre-existing
// our_league_picks mapping read `pick.team_nickname` directly, which was always
// undefined. This file proves the fix (join via fpl_entry_gameweek's entry_id ->
// team_nickname) and covers the new ownership_aggregates field built on the same join.
//
// Run BEFORE the fix: expect FAIL on tests marked "current bug".
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
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

function pickRow({ entryId, gw, playerName, isCaptain, points }) {
  return {
    season: '2025/26',
    entry_id: entryId,
    gameweek: gw,
    player_name: playerName,
    is_captain: !!isCaptain,
    is_bench: false,
    points
  };
}

// Routes fpl_entry_gameweek / fpl_entry_picks scans by inspecting FilterExpression,
// since different call sites (getManagerNamesForGW vs getManagerSeasonAggregates vs
// getOurLeaguePicks) scan the same tables with different filters.
function baseDynamoRouter({ entryGwByGw, picksByGw } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    const fe = command.input.FilterExpression || '';

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
    // Some test questions incidentally contain playerGwData/seasonTotals keywords
    // (e.g. "player", "this gameweek") alongside the ownership keywords under test --
    // these tables just need to resolve harmlessly to empty, they're not what's asserted.
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_season_totals' && type === 'QueryCommand') return { Items: [] };

    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      // getManagerNamesForGW filters on "season = :s AND gameweek = :gw"; other call
      // sites (getManagerSeasonAggregates) filter on season only. Both are satisfied by
      // the same full set of rows here since these tests only use one gameweek.
      return { Items: entryGwByGw || [] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      return { Items: picksByGw || [] };
    }
    return undefined;
  };
}

test('[current bug] our_league_picks resolves manager names via the entry_id join, not the nonexistent pick.team_nickname field', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGwByGw: [
      entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1 }),
      entryGwRow({ entryId: 102, name: 'Suberox', gw: 1 })
    ],
    picksByGw: [
      pickRow({ entryId: 101, gw: 1, playerName: 'Haaland', isCaptain: true, points: 20 }),
      pickRow({ entryId: 102, gw: 1, playerName: 'Salah', points: 15 })
    ]
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Who captained Haaland this week?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);

    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const picks = JSON.parse(contextBlock.match(/<manager_picks>(.*?)<\/manager_picks>/)[1]);

    assert.strictEqual(picks.length, 2);
    const haalandPick = picks.find((p) => p.player === 'Haaland');
    assert.strictEqual(haalandPick.manager, 'Da Movement', 'Expected the entry_id join to resolve the real manager name, not undefined');
    assert.strictEqual(haalandPick.is_captain, true);
    const salahPick = picks.find((p) => p.player === 'Salah');
    assert.strictEqual(salahPick.manager, 'Suberox');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] an unresolvable entry_id falls back to "Unknown" rather than undefined', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGwByGw: [], // no fpl_entry_gameweek rows at all -- name lookup will miss
    picksByGw: [
      pickRow({ entryId: 999, gw: 1, playerName: 'Haaland', isCaptain: true, points: 20 })
    ]
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who captained this week?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const picks = JSON.parse(contextBlock.match(/<manager_picks>(.*?)<\/manager_picks>/)[1]);

    assert.strictEqual(picks[0].manager, 'Unknown');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] ownership_aggregates identifies the most-owned player across managers', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGwByGw: [
      entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1 }),
      entryGwRow({ entryId: 102, name: 'Suberox', gw: 1 }),
      entryGwRow({ entryId: 103, name: 'Ronald', gw: 1 })
    ],
    picksByGw: [
      pickRow({ entryId: 101, gw: 1, playerName: 'Haaland', points: 20 }),
      pickRow({ entryId: 102, gw: 1, playerName: 'Haaland', points: 20 }),
      pickRow({ entryId: 103, gw: 1, playerName: 'Salah', points: 10 })
    ]
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who is the most owned player this gameweek?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const agg = JSON.parse(contextBlock.match(/<ownership_aggregates>(.*?)<\/ownership_aggregates>/)[1]);

    assert.strictEqual(agg.most_owned_player.player, 'Haaland');
    assert.strictEqual(agg.most_owned_player.ownership_count, 2);
    assert.deepStrictEqual(agg.most_owned_player.owned_by.sort(), ['Da Movement', 'Suberox']);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] ownership_aggregates.differentials only includes players owned by exactly one manager, sorted by points', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGwByGw: [
      entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1 }),
      entryGwRow({ entryId: 102, name: 'Suberox', gw: 1 }),
      entryGwRow({ entryId: 103, name: 'Ronald', gw: 1 })
    ],
    picksByGw: [
      pickRow({ entryId: 101, gw: 1, playerName: 'Haaland', points: 20 }),
      pickRow({ entryId: 102, gw: 1, playerName: 'Haaland', points: 20 }), // owned by 2 -- not a differential
      pickRow({ entryId: 103, gw: 1, playerName: 'Watkins', points: 12 }), // owned by 1 -- differential
      pickRow({ entryId: 101, gw: 1, playerName: 'Bowen', points: 18 }) // owned by 1 -- differential, higher points
    ]
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Which player is a differential this gameweek?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const agg = JSON.parse(contextBlock.match(/<ownership_aggregates>(.*?)<\/ownership_aggregates>/)[1]);

    assert.strictEqual(agg.differentials.length, 2);
    assert.strictEqual(agg.differentials[0].player, 'Bowen', 'Expected differentials sorted by points_this_gw descending');
    assert.strictEqual(agg.differentials[1].player, 'Watkins');
    assert.ok(agg.differentials.every((d) => d.ownership_count === 1));
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] an ownership question fetches fpl_entry_picks/fpl_entry_gameweek even without captain wording', async () => {
  const seen = new Set();
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    seen.add(table);
    return baseDynamoRouter({ entryGwByGw: [], picksByGw: [] })(command);
  });
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who owns the most differentials?', season: '2025/26' }, {});
    assert.ok(seen.has('fpl_entry_picks'), 'Expected an ownership question to scan fpl_entry_picks');
    assert.ok(seen.has('fpl_entry_gameweek'), 'Expected an ownership question to scan fpl_entry_gameweek for the name join');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] a pure standings question does not touch fpl_entry_picks/fpl_entry_gameweek', async () => {
  // No `season` passed -- stays on the current season (resolved via getActiveGameweek's
  // live fetch, mocked below) rather than a historical one, since a historical season
  // always resolves its gameweek via getLatestStoredGameweek's fpl_entry_gameweek scan
  // regardless of which context fields the question needs -- that's pre-existing
  // resolveSeasonContext behavior, not something this test is about.
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      throw new Error('Unexpected fpl_entry_picks scan -- a standings question doesn\'t need picks/ownership data');
    }
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      throw new Error('Unexpected fpl_entry_gameweek scan -- a standings question doesn\'t need the name join');
    }
    return baseDynamoRouter({ entryGwByGw: [], picksByGw: [] })(command);
  });
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'What are our current standings?' }, {});
    assert.strictEqual(result.statusCode, 200);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] the system prompt covers ownership_aggregates and distinguishes league differentials from global FPL ownership', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({ entryGwByGw: [], picksByGw: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Which player is a differential?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(payload.system, /<ownership_aggregates>/);
    assert.match(payload.system, /OWNERSHIP \/ DIFFERENTIALS/);
    assert.match(payload.system, /global FPL ownership/i);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
