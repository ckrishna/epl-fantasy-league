// utils/group-seasons.mjs -- resolves which seasons Trends' cross-season walk should
// consider, scoped to a league's group via the group_seasons table (replaces the older
// leagues/league_group_id design tested in league-groups.test.mjs -- see that file's
// header comment for the full "why").

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { getAllowedSeasonsForLeague } from '../utils/group-seasons.mjs';

test('returns null (no scoping) when no league id is given, without touching DynamoDB', async () => {
  const dynamoMock = installDynamoMock(() => {
    throw new Error('should not query DynamoDB when leagueId is null');
  });

  const result = await getAllowedSeasonsForLeague(null);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns null when the league_id is not in any group_seasons row yet', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [] };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague(999999);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns every season sharing the same group_id when the league_id resolves to one', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      assert.strictEqual(command.input.ExpressionAttributeValues[':lid'], 438107);
      return { Items: [{ group_id: 'carpe-diem', season_string: '2026/27', league_id: 438107 }] };
    }
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'group_seasons') {
      assert.strictEqual(command.input.ExpressionAttributeValues[':g'], 'carpe-diem');
      return {
        Items: [
          { group_id: 'carpe-diem', season_string: '2019/20', league_id: null },
          { group_id: 'carpe-diem', season_string: '2025/26', league_id: 212889 },
          { group_id: 'carpe-diem', season_string: '2026/27', league_id: 438107 }
        ]
      };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague(438107);

  assert.ok(result instanceof Set);
  assert.deepStrictEqual([...result].sort(), ['2019/20', '2025/26', '2026/27']);
  dynamoMock.restore();
});

test('accepts a string leagueId (as it arrives from a URL query param) the same as a number', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      // Confirms the Number() coercion happens -- a raw string would never match a
      // Number-typed attribute value in a real DynamoDB FilterExpression.
      assert.strictEqual(command.input.ExpressionAttributeValues[':lid'], 438107);
      return { Items: [] };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague('438107');

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns null if group_seasons somehow has the group_id but no season rows resolve', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [{ group_id: 'carpe-diem', season_string: '2026/27', league_id: 438107 }] };
    }
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [] };
    }
    return undefined;
  });

  const result = await getAllowedSeasonsForLeague(438107);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});
