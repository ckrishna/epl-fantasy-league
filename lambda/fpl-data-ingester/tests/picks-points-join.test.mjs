// EVAL: storePicks()'s `points` field in index.mjs
//
// Bug: `points: pick.points || 0` read a field that never exists on FPL's
// `/entry/{id}/event/{gw}/picks/` response (that endpoint only ever returns `element`,
// `position`, `multiplier`, `is_captain`, `is_vice_captain`). Confirmed live against
// fpl_entry_picks for 2025/26 GW20 and GW38 -- all 3,144 scanned rows had points: 0.
// Per-player gameweek points live on a separate endpoint
// (`/event/{gw}/live/`, `{elements: [{id, stats: {total_points}}]}`), keyed by player
// element id, not by manager -- storePicks never fetched or joined against it.
//
// Fix: getLiveGameweekStats(gw) fetches that endpoint once per gameweek (not once per
// manager -- the handler now fetches it up front, before the manager loop, and passes
// the resulting Map into storePicks for every manager that gameweek). storePicks joins
// each pick's `element` against that map instead of reading pick.points.
//
// Run BEFORE the fix: expect FAIL on tests marked "current bug".
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 162357, entry_name: 'Da Movement', player_name: 'Michael Kojo Brown' };

function picksResponse(picks) {
  return jsonResponse({
    entry_history: {
      points: 50,
      event_transfers_cost: 0,
      total_points: 1000,
      event_transfers: 1,
      transfers_left: 1,
      active_chip: null,
      bank: 5,
      value: 1000
    },
    picks
  });
}

function liveStatsResponse(elementPoints) {
  // elementPoints: { [elementId]: totalPoints }
  return jsonResponse({
    elements: Object.entries(elementPoints).map(([id, total_points]) => ({
      id: Number(id),
      stats: { total_points }
    }))
  });
}

function installIngesterDynamoMock({ currentSeason }) {
  const batchWrites = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;

    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: currentSeason, current: true, league_id: 438107 }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') {
      return { Items: [] };
    }
    if (name === 'PutCommand') {
      return {};
    }
    if (name === 'BatchWriteCommand') {
      batchWrites.push(...(command.input.RequestItems.fpl_entry_picks || []));
      return {};
    }
    return undefined;
  });
  return { ...dynamoMock, batchWrites };
}

test('[current bug] stored pick points come from the live per-gameweek endpoint, not the never-populated pick.points field', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/20/live/')) return liveStatsResponse({ 501: 12, 502: 0, 503: 8 });
    if (url.includes('/picks/')) {
      return picksResponse([
        { element: 501, position: 1, multiplier: 1, is_captain: false, is_vice_captain: false }, // note: no `points` field at all, same as the real FPL API
        { element: 502, position: 2, multiplier: 1, is_captain: false, is_vice_captain: false },
        { element: 503, position: 3, multiplier: 2, is_captain: true, is_vice_captain: false }
      ]);
    }
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});

    // Mid-season events (buildMidSeasonEvents(20, 38)) means gwsToFetch is [19, 20] --
    // only GW20's live stats are mocked above, so restrict this assertion to GW20's
    // rows; GW19 legitimately falls back to 0 (no live-stats mock for it), which is
    // exactly what the graceful-degradation test below covers on its own.
    const gw20Writes = dynamoMock.batchWrites.filter((w) => w.PutRequest.Item.gameweek === 20);
    assert.strictEqual(gw20Writes.length, 3);
    const byElement = Object.fromEntries(gw20Writes.map((w) => [w.PutRequest.Item.player_id, w.PutRequest.Item.points]));

    assert.strictEqual(byElement[501], 12, 'Expected element 501\'s live total_points (12), not pick.points (undefined -> old behavior would store 0)');
    assert.strictEqual(byElement[502], 0, 'A real 0 (player who didn\'t play) should still store as 0, not be confused with a missing lookup');
    assert.strictEqual(byElement[503], 8, 'Expected the captain\'s RAW points (8), not pre-multiplied by their x2 multiplier -- multiplier is stored separately');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[current bug] a player missing from the live-stats response falls back to 0, not a crash', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/20/live/')) return liveStatsResponse({}); // nobody in the live response
    if (url.includes('/picks/')) {
      return picksResponse([{ element: 999, position: 1, multiplier: 1, is_captain: false, is_vice_captain: false }]);
    }
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    assert.strictEqual(dynamoMock.batchWrites[0].PutRequest.Item.points, 0);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[current bug] live stats are fetched once per gameweek, not once per manager', async () => {
  const managers = [
    { entry: 1, entry_name: 'A', player_name: 'A' },
    { entry: 2, entry_name: 'B', player_name: 'B' },
    { entry: 3, entry_name: 'C', player_name: 'C' }
  ];
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: managers } });
    if (url.includes('/live/')) return liveStatsResponse({ 501: 5 });
    if (url.includes('/picks/')) return picksResponse([{ element: 501, position: 1, multiplier: 1, is_captain: false, is_vice_captain: false }]);
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    const liveCalls = fetchMock.calls.filter((c) => c.url.includes('/live/'));
    // 2 gameweeks in gwsToFetch (19 and 20, mid-season) x 1 fetch each = 2, regardless
    // of there being 3 managers -- a per-manager fetch would show 6 here instead.
    assert.strictEqual(liveCalls.length, 2, `Expected exactly 2 live-stats calls (one per gameweek in gwsToFetch), got ${liveCalls.length}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[current bug] a failed live-stats fetch degrades gracefully to 0 points rather than failing the whole run', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/live/')) return jsonResponse({}, { ok: false, status: 500 });
    if (url.includes('/picks/')) return picksResponse([{ element: 501, position: 1, multiplier: 1, is_captain: false, is_vice_captain: false }]);
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    const result = await handler({});
    assert.strictEqual(result.statusCode, 200, 'A live-stats fetch failure should not fail the whole ingestion run');
    assert.strictEqual(dynamoMock.batchWrites[0].PutRequest.Item.points, 0);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
