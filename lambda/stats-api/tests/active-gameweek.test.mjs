// EVAL: getActiveGameweek() in utils/dynamodb.mjs
//
// Bug: activeGW is computed as `data.events.find(e => e.is_current)?.id || 26`.
// Once a season ends (or during the off-season), FPL's bootstrap-static never marks
// any event as is_current, so this silently falls back to a hardcoded `26` -- a stale
// value that happened to be correct partway through the 2025/26 season but is wrong
// forever after. This is the root cause of the live dashboard defaulting to GW25
// instead of GW38 once the season concluded.
//
// Run BEFORE the fix: expect FAIL on the two tests marked "current bug".
// Run AFTER the fix: expect all tests to PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { getActiveGameweek } from '../utils/dynamodb.mjs';

test('[current bug] post-season: resolves to the true last-finished gameweek, not a hardcoded fallback', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  // No DynamoDB access should be required for this path (bootstrap already tells us
  // which gameweeks finished) -- but install a mock anyway so an unexpected code path
  // fails loudly with a clear message rather than a raw network error.
  const dynamoMock = installDynamoMock(() => {
    throw new Error('Unexpected DynamoDB call for the post-season happy path');
  });

  try {
    const result = await getActiveGameweek();
    assert.strictEqual(result, 38, `Expected the real final gameweek (38), got ${result}. ` +
      `This almost certainly means the code is still using the hardcoded "|| 26" fallback.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] mid-season: still resolves correctly when is_current is properly set', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38) }));
    }
    return null;
  });

  try {
    const result = await getActiveGameweek();
    assert.strictEqual(result, 20, `Expected the live current gameweek (20), got ${result}.`);
  } finally {
    fetchMock.restore();
  }
});

test('[current bug] total FPL API failure: falls back to our own latest stored data, not a hardcoded gameweek', async () => {
  const fetchMock = installFetchMock(() => {
    throw new Error('simulated network failure reaching fantasy.premierleague.com');
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'fpl_entry_gameweek' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ gameweek: 25 }, { gameweek: 38 }, { gameweek: 12 }] };
    }
    return undefined;
  });

  try {
    const result = await getActiveGameweek();
    assert.strictEqual(result, 38, `Expected the fallback to consult our own stored data and return the ` +
      `highest gameweek we actually have (38), got ${result}. A hardcoded fallback would return 26 here ` +
      `regardless of what data we actually have.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
