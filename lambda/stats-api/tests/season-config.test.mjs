// EVAL: queryLeagueStandings() in utils/dynamodb.mjs
//
// Bug: the DynamoDB key is built from a hardcoded literal `2025/26#${gw}`, completely
// independent of the `seasons` table that three OTHER lambdas (fpl-bootstrap, genbi
// handler, fpl-global-stats-weekly) already use as the source of truth for "what
// season is currently active". When the 2026/27 season starts and someone flips the
// `current` flag in that table, this function will keep querying the old season's
// partition and silently return nothing.
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { queryLeagueStandings } from '../utils/dynamodb.mjs';

test('[current bug] queries using the season marked current in the seasons table, not a hardcoded literal', async () => {
  let capturedQuery = null;

  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      // Simulate the new season having already started and been marked current.
      return { Items: [{ season_id: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      capturedQuery = command;
      return { Items: [] };
    }
    return undefined;
  });

  try {
    await queryLeagueStandings(1);
    assert.ok(capturedQuery, 'Expected a QueryCommand against fpl_league_standings');
    const key = capturedQuery.input.ExpressionAttributeValues[':se'];
    assert.strictEqual(key, '2026/27#1', `Expected the query key to use the current season from the ` +
      `seasons table ("2026/27#1"), got "${key}". This means the season string is still hardcoded.`);
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] still queries the right partition for the season that was active all along', async () => {
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: '2025/26', current: true }] };
    }
    if (table === 'fpl_league_standings' && command.constructor.name === 'QueryCommand') {
      return { Items: [{ season_event: '2025/26#25', total_points: 1537 }] };
    }
    return undefined;
  });

  try {
    const result = await queryLeagueStandings(25);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].season_event, '2025/26#25');
  } finally {
    dynamoMock.restore();
  }
});
