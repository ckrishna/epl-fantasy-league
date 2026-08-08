// EVAL: handleGenBI() in handlers/genbi.mjs
//
// Bug: genbi.mjs has its own private getLatestGameweek() that duplicates (badly) the
// logic already fixed in utils/dynamodb.mjs's getActiveGameweek() -- it does its own
// live fetch('.../bootstrap-static/') and falls back to a hardcoded `26` whenever FPL
// doesn't mark any event as current. That's exactly the GW25-stuck bug, just reappearing
// in a second, unfixed copy of the same logic. Same root cause class as #14/#15/#21's
// underlying fix, now in GenBI (GitHub #34).
//
// Run BEFORE the fix: expect FAIL on the two tests marked "current bug".
// Run AFTER the fix: expect all tests to PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

function baseDynamoRouter({ seasonId = 1, seasonString = '2025/26', storedGameweeks = [] } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;

    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: seasonId, season_string: seasonString, current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') {
      return { Items: [] };
    }
    if (table === 'player_event_stats' && type === 'QueryCommand') {
      return { Items: [] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      return { Items: [] };
    }
    if (table === 'gw-winners-cache' && type === 'ScanCommand') {
      return { Items: [] };
    }
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      return { Items: storedGameweeks.map((gw) => ({ gameweek: gw })) };
    }
    return undefined;
  };
}

test('[current bug] post-season: GenBI answers against the true final gameweek, not a hardcoded fallback', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter());
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.gameweek, 38, `Expected GenBI to resolve the real final gameweek (38), got ` +
      `${body.gameweek}. This almost certainly means genbi.mjs's own getLatestGameweek() is still using its ` +
      `private "|| 26" fallback instead of the shared, already-fixed getActiveGameweek().`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] total FPL API failure: GenBI falls back to our own stored data, not a hardcoded gameweek', async () => {
  const fetchMock = installFetchMock(() => {
    throw new Error('simulated network failure reaching fantasy.premierleague.com');
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ storedGameweeks: [25, 38, 12] }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.gameweek, 38, `Expected the fallback to consult our own stored data and return ` +
      `the highest gameweek we actually have (38), got ${body.gameweek}. A hardcoded fallback would return 26 ` +
      `here regardless of what data we actually have.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] still resolves the numeric season_id (not season_string) for teams/player_event_stats queries', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });

  let capturedTeamsQuery = null;
  let capturedPlayerStatsQuery = null;
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') {
      capturedTeamsQuery = command;
      return { Items: [] };
    }
    if (table === 'player_event_stats' && type === 'QueryCommand') {
      capturedPlayerStatsQuery = command;
      return { Items: [] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      return { Items: [] };
    }
    if (table === 'gw-winners-cache' && type === 'ScanCommand') {
      return { Items: [] };
    }
    return undefined;
  });
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.ok(capturedTeamsQuery, 'Expected a QueryCommand against teams');
    assert.strictEqual(capturedTeamsQuery.input.ExpressionAttributeValues[':sid'], 2,
      'teams query should use the numeric season_id (2), not the season_string ("2026/27")');
    assert.ok(capturedPlayerStatsQuery, 'Expected a QueryCommand against player_event_stats');
    assert.strictEqual(capturedPlayerStatsQuery.input.ExpressionAttributeValues[':sid'], 2,
      'player_event_stats query should use the numeric season_id (2), not the season_string');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
