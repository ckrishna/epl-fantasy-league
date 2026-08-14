// utils/league-groups.mjs -- resolves which seasons Trends' cross-season walk should
// consider, scoped to a league's league_group_id (see that file's header comment for
// the full "why" -- FPL recycles league_id every season, so this is what actually
// links multiple seasons together as the same continuing group of managers).

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { getAllowedSeasonsForLeague } from '../utils/league-groups.mjs';

test('returns null (no scoping) when no league id is given, without touching DynamoDB', async () => {
  const dynamoMock = installDynamoMock(() => {
    throw new Error('should not query DynamoDB when leagueId is null');
  });

  const result = await getAllowedSeasonsForLeague(null);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns null when the league is not registered in the leagues table', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'leagues') {
      return { Items: [] };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague(438107);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns null when the league is registered but has no league_group_id set', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'leagues') {
      return { Items: [{ league_id: 438107, season_string: '2026/27', league_group_id: null }] };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague(438107);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns every season sharing the same league_group_id when one is set', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'leagues') {
      assert.strictEqual(command.input.ExpressionAttributeValues[':lid'], 438107);
      return { Items: [{ league_id: 438107, season_string: '2026/27', league_group_id: 'carpe-diem' }] };
    }
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'leagues') {
      assert.strictEqual(command.input.ExpressionAttributeValues[':g'], 'carpe-diem');
      return {
        Items: [
          { league_id: 438107, season_string: '2026/27', league_group_id: 'carpe-diem' },
          { league_id: 212889, season_string: '2025/26', league_group_id: 'carpe-diem' }
        ]
      };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague(438107);

  assert.ok(result instanceof Set);
  assert.deepStrictEqual([...result].sort(), ['2025/26', '2026/27']);
  dynamoMock.restore();
});

test('accepts a string leagueId (as it arrives from a URL query param) the same as a number', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'leagues') {
      // Confirms the Number() coercion happens -- a raw string key would never match
      // a Number-typed partition key attribute in real DynamoDB.
      assert.strictEqual(command.input.ExpressionAttributeValues[':lid'], 438107);
      return { Items: [{ league_id: 438107, season_string: '2026/27', league_group_id: null }] };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague('438107');

  assert.strictEqual(result, null);
  dynamoMock.restore();
});
