// utils/group-seasons.mjs's getMoneyConfigForLeagueId -- resolves a league's real-money
// prize-pool config (buy-in, per-GW payout, top-N split, last-place-forgiveness
// threshold) via the same league_id -> group_id -> groups row path getGroupNameForLeagueId
// already uses. Deliberately opt-in: returns null for anything not explicitly configured,
// so an unconfigured or unregistered league is a silent no-op, not an error.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { getMoneyConfigForLeagueId } from '../utils/group-seasons.mjs';

test('returns null when no league id is given, without touching DynamoDB', async () => {
  const dynamoMock = installDynamoMock(() => {
    throw new Error('should not query DynamoDB when leagueId is null');
  });

  const result = await getMoneyConfigForLeagueId(null);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns null when the league_id has no group_seasons row', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [] };
    }
    return undefined;
  });

  const result = await getMoneyConfigForLeagueId(999999);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns null when the group exists but money_enabled is not true', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [{ group_id: 'carpe-diem', league_id: 438107 }] };
    }
    if (command.constructor.name === 'GetCommand' && command.input.TableName === 'groups') {
      assert.strictEqual(command.input.Key.group_id, 'carpe-diem');
      // Registered group, but nobody's ever run set-league-money-config.mjs against it.
      return { Item: { group_id: 'carpe-diem', name: 'Carpe Diem' } };
    }
    return undefined;
  });

  const result = await getMoneyConfigForLeagueId(438107);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns null when the group row does not exist at all', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [{ group_id: 'unregistered-league', league_id: 616920 }] };
    }
    if (command.constructor.name === 'GetCommand' && command.input.TableName === 'groups') {
      return { Item: undefined };
    }
    return undefined;
  });

  const result = await getMoneyConfigForLeagueId(616920);

  assert.strictEqual(result, null);
  dynamoMock.restore();
});

test('returns the config, camelCased, when money_enabled is true', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [{ group_id: 'carpe-diem', league_id: 438107 }] };
    }
    if (command.constructor.name === 'GetCommand' && command.input.TableName === 'groups') {
      return {
        Item: {
          group_id: 'carpe-diem',
          name: 'Carpe Diem',
          money_enabled: true,
          buy_in: 30,
          gw_payout: 5,
          top_splits: [70, 30, 10],
          last_place_min_wins_to_keep: 2,
          total_gameweeks: 38
        }
      };
    }
    return undefined;
  });

  const result = await getMoneyConfigForLeagueId(438107);

  assert.deepStrictEqual(result, {
    buyIn: 30,
    gwPayout: 5,
    topSplits: [70, 30, 10],
    lastPlaceMinWinsToKeep: 2,
    totalGameweeks: 38
  });
  dynamoMock.restore();
});

test('totalGameweeks defaults to 38 (standard EPL season) when not set on the row', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [{ group_id: 'carpe-diem', league_id: 438107 }] };
    }
    if (command.constructor.name === 'GetCommand' && command.input.TableName === 'groups') {
      return {
        Item: {
          group_id: 'carpe-diem',
          money_enabled: true,
          buy_in: 30,
          gw_payout: 5,
          top_splits: [70, 30, 10]
          // no total_gameweeks at all
        }
      };
    }
    return undefined;
  });

  const result = await getMoneyConfigForLeagueId(438107);

  assert.strictEqual(result.totalGameweeks, 38);
  dynamoMock.restore();
});

test('lastPlaceMinWinsToKeep defaults to 0 (rule off) when not set on the row', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      return { Items: [{ group_id: 'carpe-diem', league_id: 438107 }] };
    }
    if (command.constructor.name === 'GetCommand' && command.input.TableName === 'groups') {
      return {
        Item: {
          group_id: 'carpe-diem',
          money_enabled: true,
          buy_in: 30,
          gw_payout: 5,
          top_splits: [70, 30, 10]
          // no last_place_min_wins_to_keep at all
        }
      };
    }
    return undefined;
  });

  const result = await getMoneyConfigForLeagueId(438107);

  assert.strictEqual(result.lastPlaceMinWinsToKeep, 0);
  dynamoMock.restore();
});
