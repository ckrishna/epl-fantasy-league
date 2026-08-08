// EVAL: season dropdown backend (task #14)
//
// Three gaps:
//  1. handleStandings()/handleWinners() never read a `season` query param -- the
//     utils-layer functions (queryLeagueStandings, getGWWinners) already accept an
//     optional season override, but nothing wires a request's ?season= through to them.
//  2. No way to list which seasons exist at all (no endpoint, no utils function) --
//     a frontend dropdown has nothing to populate itself from.
//  3. Browsing a past season must NOT consult live FPL bootstrap-static -- that
//     reflects whatever's happening in the real, currently-active season, which is
//     irrelevant when looking at history. getActiveGameweek() has no season param
//     and always hits live FPL; browsing history needs a path that never does.
//
// Run BEFORE the fix: expect FAIL on all three "current bug" tests.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock, applyEqualityFilter } from './helpers/mock-dynamo.mjs';
import { handleStandings } from '../handlers/standings.mjs';
import { handleWinners } from '../handlers/winners.mjs';
import { getAllSeasons } from '../utils/dynamodb.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };

test('[current bug] browsing a past season via ?season= does not consult live FPL data', async () => {
  // If the code incorrectly falls through to the live-FPL path, this mock would hand
  // back a mid-season snapshot (GW5) -- a clearly wrong answer for 2025/26, whose real
  // final gameweek was 38. Asserting on fetchMock.calls (not just the final number)
  // catches the bug even if getActiveGameweek()'s internal try/catch would otherwise
  // mask it by falling back to the same correct-looking value.
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(5, 38) }));
    }
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] }; // current season, NOT the one requested
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') {
      return { Items: [{ gameweek: 38, season: '2025/26' }] };
    }
    if (table === 'fpl_league_standings' && name === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':se'];
      if (key === '2025/26#38') {
        return { Items: [{ season_event: '2025/26#38', manager_name: 'Da Movement', total_points: 2378 }] };
      }
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const response = await handleStandings({ season: '2025/26' }, CORS);
    const body = JSON.parse(response.body);

    assert.strictEqual(fetchMock.calls.length, 0, `Expected zero live FPL API calls when browsing a past ` +
      `season, got ${fetchMock.calls.length}: ${fetchMock.calls.map((c) => c.url).join(', ')}. Browsing history ` +
      `should never depend on what's happening in the currently-active season.`);
    assert.strictEqual(body.season, '2025/26', `Expected the response to echo the requested season, got "${body.season}"`);
    assert.strictEqual(body.gameweek, 38, `Expected GW38 (2025/26's true final gameweek), got ${body.gameweek}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[current bug] handleWinners scopes results to the requested season via query param', async () => {
  const allItems = [
    { season: '2025/26', gameweek: 38, winners: [{ manager_name: 'Da Movement' }], last_synced: '2026-05-20T00:00:00Z' },
    { season: '2026/27', gameweek: 1, winners: [{ manager_name: 'COYS' }], last_synced: '2026-08-22T00:00:00Z' }
  ];

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'gw-winners-cache' && name === 'ScanCommand') {
      return { Items: applyEqualityFilter(allItems, command, 'season') };
    }
    return undefined;
  });

  try {
    const response = await handleWinners({ season: '2025/26' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.season, '2025/26', `Expected the response to echo the requested season, got "${body.season}"`);
    assert.strictEqual(body.finished_gameweeks.length, 1, `Expected only 2025/26's winner row, got ${body.finished_gameweeks.length}`);
    assert.strictEqual(body.finished_gameweeks[0]?.season, '2025/26');
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] a seasons-listing function returns every season, not just the current one', async () => {
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      return {
        Items: [
          { season_id: 1, season_string: '2025/26', current: false, status: 'completed', total_gameweeks: 38 },
          { season_id: 2, season_string: '2026/27', current: true, status: 'active', total_gameweeks: 38 }
        ]
      };
    }
    return undefined;
  });

  try {
    const seasons = await getAllSeasons();
    assert.strictEqual(seasons.length, 2, `Expected both seasons back, got ${seasons?.length}. A dropdown ` +
      `needs every season, not just whichever one is current.`);
    assert.deepStrictEqual(seasons.map((s) => s.season_string).sort(), ['2025/26', '2026/27']);
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] handleStandings/handleWinners still default to the current season with no ?season= param', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(10, 38) }));
    return null;
  });

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && name === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':se'];
      if (key === '2026/27#10') return { Items: [{ season_event: '2026/27#10', manager_name: 'COYS', total_points: 100 }] };
      return { Items: [] };
    }
    return undefined;
  });

  try {
    const response = await handleStandings({}, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.season, '2026/27', 'Expected default behavior to use the current season');
    assert.strictEqual(body.gameweek, 10);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
