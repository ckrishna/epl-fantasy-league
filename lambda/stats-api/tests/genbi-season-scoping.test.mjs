// EVAL: handleGenBI() season scoping.
//
// Bug: unlike handleStandings/handleWinners (which accept ?season= and stopped
// touching live FPL data for historical seasons), handleGenBI has no concept of
// "season" at all -- it always resolves whatever season is marked `current` in the
// seasons table. This makes it impossible to ask GenBI about a past season (e.g.
// 2025/26, which has real data) once a new season starts and `current` flips to
// 2026/27 (which starts out empty). The frontend season dropdown already exists for
// Standings/Winners; GenBI was never wired to it.
//
// Run BEFORE the fix: expect FAIL on the tests marked "current bug".
// Run AFTER the fix: expect all tests to PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

// seasons table has two distinct query shapes hitting it: getCurrentSeasonInfo() scans
// WITH a `current = true` FilterExpression (must return only the current row), while
// getAllSeasons() scans with NO FilterExpression (must return every row). Both are
// ScanCommands, so they're only distinguishable by whether FilterExpression is present.
const ALL_SEASONS = [
  { season_id: 1, season_string: '2025/26' },
  { season_id: 2, season_string: '2026/27', current: true }
];

function baseDynamoRouter({ capturedQueries = {} } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;

    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};

    if (table === 'seasons' && type === 'ScanCommand') {
      if (command.input.FilterExpression) {
        return { Items: ALL_SEASONS.filter((s) => s.current) };
      }
      return { Items: ALL_SEASONS };
    }
    if (table === 'teams' && type === 'QueryCommand') {
      capturedQueries.teams = command;
      return { Items: [] };
    }
    if (table === 'player_event_stats' && type === 'QueryCommand') {
      capturedQueries.playerStats = command;
      return { Items: [] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') {
      capturedQueries.gwWinners = command;
      return { Items: [] };
    }
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      return { Items: [{ gameweek: 38 }, { gameweek: 25 }] };
    }
    return undefined;
  };
}

test('[current bug] browsing a past season makes zero live FPL calls, same guarantee as standings/winners', async () => {
  const fetchMock = installFetchMock(() => null); // any fetch call throws -- there should be none
  const capturedQueries = {};
  const dynamoMock = installDynamoMock(baseDynamoRouter({ capturedQueries }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(fetchMock.calls.length, 0,
      'Expected zero live FPL API calls when browsing a past season.');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] resolves the numeric season_id for the REQUESTED season, not the current one', async () => {
  const capturedQueries = {};
  const dynamoMock = installDynamoMock(baseDynamoRouter({ capturedQueries }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.ok(capturedQueries.teams, 'Expected a teams QueryCommand');
    assert.strictEqual(capturedQueries.teams.input.ExpressionAttributeValues[':sid'], 1,
      'Expected teams query to use 2025/26\'s season_id (1), not the current season\'s (2)');
    assert.ok(capturedQueries.playerStats, 'Expected a player_event_stats QueryCommand');
    assert.strictEqual(capturedQueries.playerStats.input.ExpressionAttributeValues[':sid'], 1);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] gwWinners are scoped to the requested season, not the current one', async () => {
  const capturedQueries = {};
  const dynamoMock = installDynamoMock(baseDynamoRouter({ capturedQueries }));
  const bedrockMock = installBedrockMock();

  try {
    await handleGenBI({ question: 'Who is winning?', season: '2025/26' }, {});
    assert.ok(capturedQueries.gwWinners, 'Expected a gw-winners-cache ScanCommand');
    assert.strictEqual(capturedQueries.gwWinners.input.ExpressionAttributeValues[':s'], '2025/26');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] no season provided still defaults to the current season and behaves as before', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return { ok: true, status: 200, json: async () => ({ events: [], elements: [], teams: [], element_types: [] }) };
    }
    return null;
  });
  const capturedQueries = {};
  const dynamoMock = installDynamoMock(baseDynamoRouter({ capturedQueries }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(capturedQueries.teams.input.ExpressionAttributeValues[':sid'], 2,
      'Expected the current season\'s season_id (2) when no season is provided');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
