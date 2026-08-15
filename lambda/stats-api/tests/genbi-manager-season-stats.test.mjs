// EVAL: #39 Phase 1 -- manager-level season aggregates (handlers/genbi.mjs's
// getManagerSeasonAggregates + computeWinStreaks, wired into manager_season_stats).
//
// Live testing surfaced two honest declines that map directly to documented gaps in
// GitHub issue #39: "Which player is a differential?" (Phase 2, ownership data -- not
// built here) and "Who made the best transfers?" (Phase 1, but only the ACTIVITY half
// -- transfers_made/transfer_cost exist per gameweek on fpl_entry_gameweek, there's no
// player-level transfer log, so "best" specifically stays unanswerable even after this
// change). This file covers what Phase 1 actually adds: win/loss streaks, highest/
// lowest single-GW score, season average, transfer activity counts, chip usage, bench
// points wasted, and season-long captaincy points.
//
// Run BEFORE the fix: expect FAIL on tests marked "current bug".
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

// `name` becomes real_name -- the real-name field genbi.mjs now keys manager identity
// off of (populated on every row, historical and live; see formatManagerDisplay's
// comment in genbi.mjs). `nickname` is optional and becomes team_nickname (the FPL
// squad nickname, only ever present on live rows) -- most fixtures below omit it, so
// `m.manager` resolves to exactly `name` with no parenthetical, keeping existing
// assertions unchanged; the nickname-specific test further down sets it explicitly.
function entryGwRow({ entryId, name, nickname, gw, ptsThisWeek, ptsTotal, transfersMade, transferHit, chip, chipTotalsManual }) {
  const row = {
    entry_id: entryId,
    season: '2025/26',
    real_name: name,
    team_nickname: nickname || null,
    gameweek: gw,
    points_this_week: ptsThisWeek,
    points_total: ptsTotal,
    transfers_made: transfersMade,
    transfer_cost: transferHit,
    active_chip: chip || null
  };
  if (chipTotalsManual) row.chip_totals_manual = chipTotalsManual;
  return row;
}

function pickRow({ entryId, gw, isCaptain, isBench, points, multiplier }) {
  return {
    season: '2025/26',
    entry_id: entryId,
    gameweek: gw,
    is_captain: !!isCaptain,
    is_bench: !!isBench,
    // Matches storePicks' own default: captains get multiplier 2 unless a triple-
    // captain chip bumps it to 3; everyone else defaults to 1. `points` here is always
    // the raw per-player score -- the multiplier is applied separately by whichever
    // aggregate needs it (captain_points_season does; bench_points_wasted doesn't).
    multiplier: multiplier ?? (isCaptain ? 2 : 1),
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
    if (table === 'gw-winners-cache' && type === 'ScanCommand') {
      return overrides.gwWinners ? overrides.gwWinners() : { Items: [] };
    }
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      return overrides.entryGw ? overrides.entryGw() : { Items: [] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      return overrides.picks ? overrides.picks() : { Items: [] };
    }
    return undefined;
  };
}

test('[current bug] manager_season_stats includes transfer activity, chips, bench points, and season captaincy points', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1, ptsThisWeek: 60, ptsTotal: 60, transfersMade: 1, transferHit: 0 }),
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 2, ptsThisWeek: 80, ptsTotal: 140, transfersMade: 2, transferHit: 4, chip: 'wildcard' })
      ]
    }),
    picks: () => ({
      Items: [
        pickRow({ entryId: 101, gw: 1, isCaptain: true, points: 20 }),
        pickRow({ entryId: 101, gw: 1, isBench: true, points: 5 }),
        pickRow({ entryId: 101, gw: 2, isCaptain: true, points: 30 }),
        pickRow({ entryId: 101, gw: 2, isBench: true, points: 3 })
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'How many transfers has each manager made?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);

    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const stats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);

    assert.strictEqual(stats.length, 1);
    const m = stats[0];
    assert.strictEqual(m.manager, 'Da Movement');
    assert.strictEqual(m.gameweeks_played, 2);
    assert.strictEqual(m.highest_gw_score, 80);
    assert.strictEqual(m.lowest_gw_score, 60);
    assert.strictEqual(m.average_points_per_gw, 70, 'Expected season_total_points (140, the highest points_total seen) / gameweeks_played (2)');
    assert.strictEqual(m.total_transfers_made, 3);
    assert.strictEqual(m.total_transfer_hits, 4);
    assert.deepStrictEqual(m.chips_used, [{ chip: 'wildcard', gameweek: 2 }]);
    assert.strictEqual(m.bench_points_wasted, 8, 'Expected 5 (GW1 bench) + 3 (GW2 bench) -- raw points, no multiplier applied');
    assert.strictEqual(m.captain_points_season, 100, 'Expected (20 x 2) + (30 x 2) -- captain multiplier applied to each raw score, not summed raw');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] "Best captain picks this season?" gets manager_season_stats, not just this-gameweek manager_picks', async () => {
  // Live bug (2026-08-12): this exact question -- one of the app's own default
  // suggested queries -- declined with "no season-long captain data available",
  // even though captain_points_season has existed in manager_season_stats since #39
  // Phase 1. Root cause: router.mjs's managerStats keyword group had no "captain"
  // entry at all, so a season-scoped captain question only ever triggered
  // managerPicks (this-gameweek-only picks) and manager_season_stats was never even
  // fetched, let alone sent to Claude.
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1, ptsThisWeek: 60, ptsTotal: 60, transfersMade: 0, transferHit: 0 })
      ]
    }),
    picks: () => ({
      Items: [
        pickRow({ entryId: 101, gw: 1, isCaptain: true, points: 20 })
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Best captain picks this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const stats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);

    assert.strictEqual(stats.length, 1, 'Expected manager_season_stats to actually be populated, not skipped by the router');
    assert.strictEqual(stats[0].captain_points_season, 40, 'Expected 20 x 2 (default captain multiplier)');
    assert.match(payload.system, /captain_points_season from <manager_season_stats>/, 'Expected the season-scoped captain instruction to be present in the prompt');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] chips_used_totals surfaces the manually-imported season fallback when per-gameweek active_chip is unavailable', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        // No `chip` -- active_chip is null on every row, matching 2025/26's real state.
        // chip_totals_manual only lives on the latest row, same as import-chip-totals.mjs writes it.
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1, ptsThisWeek: 60, ptsTotal: 60, transfersMade: 0, transferHit: 0 }),
        entryGwRow({
          entryId: 101, name: 'Da Movement', gw: 2, ptsThisWeek: 80, ptsTotal: 140, transfersMade: 0, transferHit: 0,
          chipTotalsManual: { wildcard: 2, freehit: 2, bboost: 2, '3xc': 2 }
        })
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'How many chips has each manager used this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const stats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);

    const m = stats.find((s) => s.manager === 'Da Movement');
    assert.deepStrictEqual(m.chips_used, [], 'No per-gameweek attribution exists for this manager/season');
    assert.deepStrictEqual(m.chips_used_totals, { wildcard: 2, freehit: 2, bboost: 2, '3xc': 2 });
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] chips_used_totals stays null when no manual import exists for that manager', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1, ptsThisWeek: 60, ptsTotal: 60, transfersMade: 0, transferHit: 0 })
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'How many chips has each manager used this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const stats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);

    assert.strictEqual(stats[0].chips_used_totals, null);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] captain_points_season applies the real multiplier, including triple-captain (x3), not a flat x2', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1, ptsThisWeek: 60, ptsTotal: 60, transfersMade: 0, transferHit: 0, chip: 'triple_captain' })
      ]
    }),
    picks: () => ({
      Items: [
        pickRow({ entryId: 101, gw: 1, isCaptain: true, points: 15, multiplier: 3 })
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'How many transfers has each manager made?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const stats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);

    assert.strictEqual(stats[0].captain_points_season, 45, 'Expected 15 x 3 (the stored multiplier for a triple-captain pick), not 15 x 2');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] win streaks reset when a manager stops winning, not just accumulate forever', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1, ptsThisWeek: 60, ptsTotal: 60, transfersMade: 0, transferHit: 0 }),
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 2, ptsThisWeek: 40, ptsTotal: 100, transfersMade: 0, transferHit: 0 }),
        entryGwRow({ entryId: 101, name: 'Da Movement', gw: 3, ptsThisWeek: 70, ptsTotal: 170, transfersMade: 0, transferHit: 0 }),
        entryGwRow({ entryId: 102, name: 'Suberox', gw: 1, ptsThisWeek: 50, ptsTotal: 50, transfersMade: 0, transferHit: 0 }),
        entryGwRow({ entryId: 102, name: 'Suberox', gw: 2, ptsThisWeek: 55, ptsTotal: 105, transfersMade: 0, transferHit: 0 }),
        entryGwRow({ entryId: 102, name: 'Suberox', gw: 3, ptsThisWeek: 45, ptsTotal: 150, transfersMade: 0, transferHit: 0 })
      ]
    }),
    // Da Movement wins GW1, Suberox wins GW2, Da Movement wins GW3 again -- Da
    // Movement's streak should reset to 1 at GW3, not read as a 2-week streak.
    gwWinners: () => ({
      Items: [
        { season: '2025/26', gameweek: 1, winners: [{ real_name: 'Da Movement' }] },
        { season: '2025/26', gameweek: 2, winners: [{ real_name: 'Suberox' }] },
        { season: '2025/26', gameweek: 3, winners: [{ real_name: 'Da Movement' }] }
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who has the longest win streak this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const stats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);

    const daMovement = stats.find((m) => m.manager === 'Da Movement');
    const suberox = stats.find((m) => m.manager === 'Suberox');

    assert.strictEqual(daMovement.current_win_streak, 1, 'Streak should reset after losing GW2, not keep accumulating from GW1');
    assert.strictEqual(daMovement.longest_win_streak, 1);
    assert.strictEqual(suberox.current_win_streak, 0, 'Suberox lost the most recent gameweek (GW3)');
    assert.strictEqual(suberox.longest_win_streak, 1);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] manager_season_stats leads with the real name, nickname secondary in parentheses', async () => {
  // Live bug (2026-08-12): GenBI answers referred to managers only by their FPL squad
  // nickname (e.g. "Biosfear", "Suberox") with no real name anywhere -- backwards from
  // Standings/Trends, which both lead with the real name and show the nickname
  // secondary ("Yash Thakker (VARsenal)"). team_nickname is the nickname field, populated
  // only on live rows; real_name is the real name, populated on every row.
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    entryGw: () => ({
      Items: [
        entryGwRow({ entryId: 101, name: 'aditya shringarpure', nickname: 'Biosfear', gw: 1, ptsThisWeek: 60, ptsTotal: 60, transfersMade: 0, transferHit: 0 })
      ]
    })
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'How many transfers has each manager made?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const stats = JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);

    assert.strictEqual(stats.length, 1);
    assert.strictEqual(stats[0].manager, 'aditya shringarpure (Biosfear)', 'Expected real name first, nickname secondary in parentheses');
    // The raw join fields (real_name/team_nickname) were only needed internally to
    // build the combined string -- Claude should see one unambiguous "manager" field,
    // not two overlapping name fields inviting it to pick the wrong one.
    assert.strictEqual(stats[0].real_name, undefined);
    assert.strictEqual(stats[0].team_nickname, undefined);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] a managerStats question fetches fpl_entry_gameweek/fpl_entry_picks; an unrelated one does not', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const seen = new Set();
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    seen.add(table);
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    return undefined;
  });
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'How many transfer hits has each manager taken?' }, {});
    assert.ok(seen.has('fpl_entry_gameweek'), 'Expected a managerStats question to scan fpl_entry_gameweek');
    assert.ok(seen.has('fpl_entry_picks'), 'Expected a managerStats question to scan fpl_entry_picks');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] a pure standings question does not touch fpl_entry_gameweek/fpl_entry_picks', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      throw new Error('Unexpected fpl_entry_gameweek scan -- a standings question doesn\'t need manager season stats');
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      throw new Error('Unexpected fpl_entry_picks scan -- a standings question doesn\'t need manager season stats');
    }
    return undefined;
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

test('[current bug] the system prompt covers manager_season_stats and is honest about not having per-transfer data', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter());
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who has the longest win streak?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(payload.system, /<manager_season_stats>/);
    assert.match(payload.system, /MANAGER SEASON STATS/);
    assert.match(payload.system, /BEST/, 'Expected an explicit rule distinguishing transfer activity counts from judging transfer quality');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
