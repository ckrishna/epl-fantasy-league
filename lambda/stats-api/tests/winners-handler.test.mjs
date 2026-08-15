// EVAL: handleWinners() and getGWWinners() in handlers/winners.mjs / utils/dynamodb.mjs
//
// Two bugs here:
//  1. handleWinners() hardcodes `active_gameweek: 26` directly in the response body,
//     completely disconnected from any real data.
//  2. getGWWinners() does an UNFILTERED Scan across the entire gw-winners-cache table.
//     Right now that's harmless because only one season's data exists. The moment the
//     2026/27 ingester starts writing new winner rows into the same table, this will
//     silently start mixing last season's and this season's gameweek winners together.
//
// Run BEFORE the fix: expect FAIL on both "current bug" tests.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock, applyEqualityFilter } from './helpers/mock-dynamo.mjs';
import { handleWinners } from '../handlers/winners.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };

function mixedSeasonWinnerItems() {
  const items = [];
  for (let gw = 1; gw <= 38; gw++) {
    items.push({ season: '2025/26', gameweek: gw, winners: [{ real_name: 'Da Movement' }], last_synced: '2026-07-23T00:00:00Z' });
  }
  // The new season has already kicked off and started writing into the same table.
  for (let gw = 1; gw <= 2; gw++) {
    items.push({ season: '2026/27', gameweek: gw, winners: [{ real_name: 'Someone New' }], last_synced: '2026-08-15T00:00:00Z' });
  }
  return items;
}

test('[current bug] active_gameweek reflects real data, not a hardcoded value', async () => {
  const allItems = mixedSeasonWinnerItems().filter((i) => i.season === '2025/26'); // single-season case first

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'gw-winners-cache' && command.constructor.name === 'ScanCommand') {
      return { Items: applyEqualityFilter(allItems, command, 'season') };
    }
    return undefined;
  });

  try {
    const response = await handleWinners({}, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.active_gameweek, 38, `Expected active_gameweek to be derived from real data ` +
      `(38, the highest gameweek present), got ${body.active_gameweek}. A hardcoded value would show 26 here ` +
      `regardless of what data actually exists.`);
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] winners are scoped to the current season only, not mixed across seasons', async () => {
  const allItems = mixedSeasonWinnerItems();

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'gw-winners-cache' && command.constructor.name === 'ScanCommand') {
      return { Items: applyEqualityFilter(allItems, command, 'season') };
    }
    return undefined;
  });

  try {
    const response = await handleWinners({}, CORS);
    const body = JSON.parse(response.body);
    const seasonsPresent = new Set(body.finished_gameweeks.map((w) => w.season));
    assert.deepStrictEqual([...seasonsPresent], ['2026/27'], `Expected only the current season's winners, ` +
      `but found: ${[...seasonsPresent].join(', ')}. An unfiltered scan would leak last season's rows in too.`);
    assert.strictEqual(body.finished_gameweeks.length, 2, 'Expected exactly the 2 new-season gameweeks, not 40');
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] single-season case still returns every gameweek, sorted newest first', async () => {
  const allItems = mixedSeasonWinnerItems().filter((i) => i.season === '2025/26');

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'gw-winners-cache' && command.constructor.name === 'ScanCommand') {
      return { Items: applyEqualityFilter(allItems, command, 'season') };
    }
    return undefined;
  });

  try {
    const response = await handleWinners({}, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.finished_gameweeks.length, 38);
    assert.strictEqual(body.finished_gameweeks[0].gameweek, 38, 'Expected newest gameweek first');
  } finally {
    dynamoMock.restore();
  }
});
