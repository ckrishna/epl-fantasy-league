// EVAL: handleGenBI()'s season-total player aggregation.
//
// Gap: GenBI only ever fetched a single gameweek's worth of player_event_stats (the
// last one), so "who scored the most this season" questions got answered from just
// that one gameweek -- confirmed live: asked about the entire 2025/26 season, got
// "Dorgu had the most points with 18" (his GW38 score, not his season total). The
// `players` table's own total_points field can't be used as a shortcut either --
// confirmed live it's a stale mid-season snapshot (last synced Feb 2026, well before
// the season actually ended). The only accurate source is aggregating every gameweek
// of player_event_stats ourselves.
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock, systemContextBlock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

function baseDynamoRouter(playerEventStatsRouter) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return playerEventStatsRouter(command);
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    return undefined;
  };
}

function getSeasonTotalsFromBedrockCall(bedrockMock) {
  const payload = JSON.parse(bedrockMock.calls[0].input.body);
  const match = systemContextBlock(payload).match(/<season_totals>(.*?)<\/season_totals>/s);
  assert.ok(match, 'Expected <season_totals> in the system prompt sent to Claude');
  return JSON.parse(match[1]);
}

test('[current bug] season_totals sums a player\'s points across every gameweek, not just the last one', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  // The per-gameweek query (used for the "this gameweek" context, unrelated to the fix
  // here) only ever asks for gameweek_player begins_with "38#"; the season-aggregate
  // query has no such prefix -- it queries the whole season_id partition.
  const dynamoMock = installDynamoMock(baseDynamoRouter((command) => {
    if (command.input.ExpressionAttributeValues[':gw']) {
      // getPlayerDataForGW's single-gameweek query
      return { Items: [] };
    }
    // Season-wide aggregation query: same player across 3 gameweeks.
    return {
      Items: [
        { player_id: 1, name: 'Haaland', team_id: 12, gameweek: 1, total_points: 12, selected_by_percent: '60.0' },
        { player_id: 1, name: 'Haaland', team_id: 12, gameweek: 2, total_points: 8, selected_by_percent: '61.0' },
        { player_id: 1, name: 'Haaland', team_id: 12, gameweek: 3, total_points: 15, selected_by_percent: '62.0' }
      ]
    };
  }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who scored the most this season?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const seasonTotals = getSeasonTotalsFromBedrockCall(bedrockMock);
    const haaland = seasonTotals.find((p) => p.name === 'Haaland');
    assert.ok(haaland, 'Expected Haaland in season_totals');
    assert.strictEqual(haaland.points, 35, `Expected 12+8+15=35 summed across gameweeks, got ${haaland.points}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] aggregates across paginated DynamoDB results, not just the first page', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  let seasonQueryCallCount = 0;
  const dynamoMock = installDynamoMock(baseDynamoRouter((command) => {
    if (command.input.ExpressionAttributeValues[':gw']) return { Items: [] };

    seasonQueryCallCount += 1;
    if (!command.input.ExclusiveStartKey) {
      // First page
      return {
        Items: [{ player_id: 2, name: 'Salah', team_id: 14, gameweek: 1, total_points: 10, selected_by_percent: '50.0' }],
        LastEvaluatedKey: { season_id: 1, gameweek_player: '1#2' }
      };
    }
    // Second (final) page
    return {
      Items: [{ player_id: 2, name: 'Salah', team_id: 14, gameweek: 2, total_points: 20, selected_by_percent: '51.0' }]
    };
  }));
  const bedrockMock = installBedrockMock();

  try {
    await handleGenBI({ question: 'Who scored the most this season?' }, {});
    assert.strictEqual(seasonQueryCallCount, 2, 'Expected the aggregation to follow LastEvaluatedKey to a second page');
    const seasonTotals = getSeasonTotalsFromBedrockCall(bedrockMock);
    const salah = seasonTotals.find((p) => p.name === 'Salah');
    assert.ok(salah, 'Expected Salah in season_totals');
    assert.strictEqual(salah.points, 30, `Expected 10+20=30 summed across both pages, got ${salah.points}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] season_totals is limited to the top 50 by aggregated points', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  const manyPlayers = Array.from({ length: 60 }, (_, i) => ({
    player_id: i + 1,
    name: `Player${i + 1}`,
    team_id: 1,
    gameweek: 1,
    total_points: i,
    selected_by_percent: '5.0'
  }));

  const dynamoMock = installDynamoMock(baseDynamoRouter((command) => {
    if (command.input.ExpressionAttributeValues[':gw']) return { Items: [] };
    return { Items: manyPlayers };
  }));
  const bedrockMock = installBedrockMock();

  try {
    await handleGenBI({ question: 'Who scored the most this season?' }, {});
    const seasonTotals = getSeasonTotalsFromBedrockCall(bedrockMock);
    assert.strictEqual(seasonTotals.length, 50, `Expected top 50, got ${seasonTotals.length}`);
    assert.strictEqual(seasonTotals[0].name, 'Player60', 'Expected the highest scorer first');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
