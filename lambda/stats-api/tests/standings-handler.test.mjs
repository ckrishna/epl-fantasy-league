// EVAL: handleStandings() in handlers/standings.mjs
//
// This is the function that actually powers the live dashboard's default view (no
// explicit ?gw= param). It combines getActiveGameweek() and queryLeagueStandings(),
// so it inherits both of those bugs: once the season ends, activeGW falls back to a
// hardcoded 26, GW26 has no cached standings row (a one-off gap from earlier in the
// season), and the walk-back loop lands on GW25 -- even though GW26 through GW38 all
// exist and are correct.
//
// Run BEFORE the fix: expect FAIL on the "current bug" test (will show gameweek 25).
// Run AFTER the fix: expect PASS (shows gameweek 38, the real final gameweek).

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handleStandings } from '../handlers/standings.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };

test('[current bug] default view (no gw param) shows the true final gameweek once the season has ended', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':se'];
      // Mirrors what we verified live: GW26 has no cached row (the historical gap),
      // GW25 and GW38 both do.
      if (key === '2025/26#26') return { Items: [] };
      if (key === '2025/26#25') {
        return { Items: [{ season_event: '2025/26#25', real_name: 'Da Movement', total_points: 1537, points_this_week: 39, transfer_cost: 0 }] };
      }
      if (key === '2025/26#38') {
        return { Items: [{ season_event: '2025/26#38', real_name: 'Da Movement', total_points: 2378, points_this_week: 69, transfer_cost: 0 }] };
      }
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const response = await handleStandings({}, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.gameweek, 38, `Expected the dashboard's default view to show GW38 (the real ` +
      `final gameweek), got GW${body.gameweek}. This is the exact "stuck at GW25" bug reported live.`);
    assert.strictEqual(body.standings[0].total_points, 2378, 'Expected final season totals, not partial GW25 totals');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] mid-season: still walks back gracefully over a genuine same-week data gap', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38) }));
    }
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':se'];
      if (key === '2025/26#20') return { Items: [] }; // this week's data hasn't landed yet
      if (key === '2025/26#19') return { Items: [{ season_event: '2025/26#19', real_name: 'Da Movement', total_points: 1200 }] };
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const response = await handleStandings({}, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.gameweek, 19, `Expected walk-back to land on GW19, got GW${body.gameweek}.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] explicit ?gw= param is still honored as-is', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':se'];
      if (key === '2025/26#10') return { Items: [{ season_event: '2025/26#10', total_points: 500 }] };
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const response = await handleStandings({ gw: '10' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.gameweek, 10);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

// Multi-league foundation (2026-08-14): a league_id query param scopes results, but
// only excludes rows that explicitly belong to a DIFFERENT league_id -- a row with no
// league_id at all (every row written before this existed) is always kept, since
// there's no ambiguity to resolve for it.
test('league_id param keeps legacy rows (no league_id) and rows matching it, excludes other leagues', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':se'];
      if (key === '2025/26#38') {
        return {
          Items: [
            { season_event: '2025/26#38', real_name: 'Legacy Manager', total_points: 100 }, // no league_id at all
            { season_event: '2025/26#38', real_name: 'Our Manager', total_points: 200, league_id: 438107 },
            { season_event: '2025/26#38', real_name: 'Other League Manager', total_points: 300, league_id: 999999 }
          ]
        };
      }
      return { Items: [] };
    }
    // No group registered for this league_id -- getMoneyConfigForLeagueId should
    // resolve to null via its normal "not found" path, not by throwing.
    if (table === 'group_seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const response = await handleStandings({ league_id: '438107' }, CORS);
    const body = JSON.parse(response.body);
    const names = body.standings.map((s) => s.real_name).sort();
    assert.deepStrictEqual(names, ['Legacy Manager', 'Our Manager']);
    assert.strictEqual(body.money_config, null, 'unregistered league_id should get no money config');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

// Real-money prize-pool feature -- money_config passthrough on the standings response.
test('money_config comes back null when no league_id is given', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const response = await handleStandings({}, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.money_config, null);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('money_config comes back populated for a league with money_enabled set, and null for a past season even with the same league_id', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      return { Items: [] };
    }
    if (table === 'group_seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ group_id: 'carpe-diem', league_id: 438107 }] };
    }
    if (table === 'groups' && command.constructor.name === 'GetCommand') {
      return {
        Item: {
          group_id: 'carpe-diem',
          money_enabled: true,
          buy_in: 30,
          gw_payout: 5,
          top_splits: [70, 30, 10],
          last_place_min_wins_to_keep: 2,
          total_gameweeks: 38
        }
      };
    }
    // Only reached by the historical-season branch below (getLatestStoredGameweek) --
    // the money_config lookup must NOT reach here at all for a historical request; if
    // the isHistorical guard in standings.mjs ever regressed, this route intentionally
    // has nothing group_seasons/groups-shaped in it, so a stray lookup would throw.
    if (table === 'fpl_entry_gameweek' && command.constructor.name === 'ScanCommand') {
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const currentSeasonResponse = await handleStandings({ league_id: '438107' }, CORS);
    const currentBody = JSON.parse(currentSeasonResponse.body);
    assert.deepStrictEqual(currentBody.money_config, {
      buyIn: 30,
      gwPayout: 5,
      topSplits: [70, 30, 10],
      lastPlaceMinWinsToKeep: 2,
      totalGameweeks: 38
    });

    // Same league_id, but browsing a past season -- money_config should be null without
    // even attempting the group_seasons/groups lookup (see standings.mjs's isHistorical
    // guard). Not asserting "no call was made" here since the DynamoDB mock would throw
    // on an unmatched route anyway if the guard were missing -- that's the real proof.
    const historicalResponse = await handleStandings({ league_id: '438107', season: '2019/20' }, CORS);
    const historicalBody = JSON.parse(historicalResponse.body);
    assert.strictEqual(historicalBody.money_config, null);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
