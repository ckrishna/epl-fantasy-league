// EVAL: handleGenBI() preferring authoritative season totals when available.
//
// Live-aggregating season totals from player_event_stats is only as complete as our
// own weekly ingestion -- confirmed live that GW31/34 of 2025/26 are partially missing
// (~150-250 players short in each), which undercounts season totals for anyone caught
// in that gap (e.g. Haaland: our data summed to 222, FPL's own record is 239). FPL's
// element-summary API exposes an authoritative season-total via history_past for any
// player still in the current player pool -- a new player_season_totals table (filled
// by a one-off backfill script) stores that, and GenBI should prefer it over the
// (potentially gappy) live aggregation whenever it's available for the requested season.
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

function baseDynamoRouter(overrides) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') {
      if (command.input.ExpressionAttributeValues[':gw']) return { Items: [] }; // single-GW query
      return overrides.playerEventStats
        ? overrides.playerEventStats(command)
        : (() => { throw new Error('Unexpected full-season player_event_stats scan'); })();
    }
    if (table === 'player_season_totals' && type === 'QueryCommand') {
      return overrides.seasonTotals ? overrides.seasonTotals(command) : { Items: [] };
    }
    return undefined;
  };
}

test('[current bug] uses authoritative season totals when available, without scanning player_event_stats', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    seasonTotals: () => ({
      Items: [
        { season_string: '2025/26', player_name: 'Haaland', team_name: 'Man City', total_points: 239 },
        { season_string: '2025/26', player_name: 'B.Fernandes', team_name: 'Man Utd', total_points: 235 }
      ]
    })
    // Note: no `playerEventStats` override provided -- if the full-season scan is
    // called anyway, the router throws, failing this test loudly.
  }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who scored the most this season?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const seasonTotals = JSON.parse(payload.system.match(/<season_totals>(.*?)<\/season_totals>/s)[1]);
    assert.strictEqual(seasonTotals[0].name, 'Haaland');
    assert.strictEqual(seasonTotals[0].points, 239,
      `Expected the authoritative total (239), not the gappy live-aggregated one, got ${seasonTotals[0].points}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] falls back to live aggregation when no authoritative data exists for the season', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    seasonTotals: () => ({ Items: [] }), // nothing backfilled for this season yet
    playerEventStats: () => ({
      Items: [{ player_id: 1, name: 'Haaland', team_id: 12, gameweek: 1, total_points: 222, selected_by_percent: '60.0' }]
    })
  }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who scored the most this season?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const seasonTotals = JSON.parse(payload.system.match(/<season_totals>(.*?)<\/season_totals>/s)[1]);
    assert.strictEqual(seasonTotals[0].name, 'Haaland');
    assert.strictEqual(seasonTotals[0].points, 222, 'Expected fallback to the live-aggregated total');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
