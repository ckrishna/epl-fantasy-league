// EVAL: handleGenBI() actually skips irrelevant DynamoDB fetches, not just the pure
// selectRelevantFields() function returning the right booleans in isolation.
//
// The router (utils/router.mjs, tested standalone in router.test.mjs) only has real
// value if genbi.mjs actually acts on it -- this proves the wiring, using the same
// "mock throws on any unmatched route" pattern already used elsewhere in this suite to
// prove a negative (a fetch that SHOULDN'T happen genuinely doesn't).
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

// Historical season (2025/26, with 2026/27 marked current) so gameweek resolution goes
// through getLatestStoredGameweek (a DynamoDB scan) instead of a live FPL fetch --
// same pattern as genbi-season-scoping.test.mjs / genbi-standings-context.test.mjs.
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
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [{ gameweek: 10 }] };
    if (overrides.router) {
      const result = overrides.router(table, type, command);
      if (result !== undefined) return result;
    }
    return undefined;
  };
}

test('[current bug] a pure standings question does not fetch player, season-totals, or picks data', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    router: (table, type) => {
      if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
      if (['teams', 'player_event_stats', 'player_season_totals'].includes(table)) {
        throw new Error(`Unexpected query against ${table} -- this question doesn't need player data`);
      }
      if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
        throw new Error('Unexpected fpl_entry_picks scan -- this question doesn\'t need manager picks');
      }
      if (table === 'gw-winners-cache' && type === 'ScanCommand') {
        throw new Error('Unexpected gw-winners-cache scan -- this question doesn\'t need win counts');
      }
      return undefined;
    }
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'What is our current standings table?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] a captain question fetches player + picks data, but not standings or season totals', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    router: (table, type) => {
      if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
      if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
      if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
      if (table === 'fpl_league_standings' || table === 'player_season_totals') {
        throw new Error(`Unexpected query against ${table} -- a captain question doesn't need this`);
      }
      if (table === 'gw-winners-cache' && type === 'ScanCommand') {
        throw new Error('Unexpected gw-winners-cache scan -- a captain question doesn\'t need win counts');
      }
      return undefined;
    }
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Best captain picks this week?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] an unrecognized question falls back to fetching everything, same as before', async () => {
  const seen = new Set();
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    router: (table, type) => {
      seen.add(table);
      if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
      if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
      if (table === 'player_season_totals' && type === 'QueryCommand') return { Items: [] };
      if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
      if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
      if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
      return undefined;
    }
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Tell me something interesting.', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
    for (const table of ['teams', 'player_event_stats', 'player_season_totals', 'fpl_entry_picks', 'gw-winners-cache', 'fpl_league_standings']) {
      assert.ok(seen.has(table), `Expected the safe fallback to still query ${table} when the question is unrecognized`);
    }
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
