// EVAL: suggestTransfer() and handleSquadAdvisor() in handlers/manager-squad.mjs
//
// GH #44's first real (non-mock) advisor piece -- a single transfer suggestion, scoped
// to exactly what the user asked for when "advancing the advisor feature to completion"
// (real transfer suggestion only, sourced from the FULL ~700-player FPL pool, not just
// the manager's own bench). Captain/fixture-outlook stay hand-written mock content in
// ManagerSquad.jsx -- out of scope for this file.
//
// Split into two halves: suggestTransfer is pure (no I/O), so it's tested directly
// against hand-built picks/pool fixtures with no mock-fetch/mock-dynamo scaffolding at
// all. handleSquadAdvisor wraps it with real DynamoDB/fetch calls, so those tests reuse
// this repo's existing mock-fetch/mock-dynamo helpers, same conventions as
// manager-squad-handler.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { suggestTransfer, handleSquadAdvisor } from '../handlers/manager-squad.mjs';
import { handler } from '../index.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const SEASON_ROW = { season_id: 2, season_string: '2026/27', current: true };

// ---- suggestTransfer (pure) ----

function pick(id, position) {
  return { player_id: id, player_position: position };
}

function poolPlayer(id, overrides = {}) {
  return {
    id,
    web_name: `Player${id}`,
    team: 1,
    element_type: 3,
    now_cost: 80,
    form: '4.0',
    selected_by_percent: '10.0',
    ep_next: '4.0',
    status: 'a',
    ...overrides
  };
}

function poolFrom(players) {
  const map = new Map();
  for (const p of players) map.set(p.id, p);
  return map;
}

test('suggestTransfer: empty picks returns no_data without touching the pool', () => {
  const result = suggestTransfer([], poolFrom([poolPlayer(1)]), 0);
  assert.deepStrictEqual(result, { found: false, reason: 'no_data' });
});

test('suggestTransfer: empty pool returns no_data', () => {
  const result = suggestTransfer([pick(1, 3)], new Map(), 0);
  assert.deepStrictEqual(result, { found: false, reason: 'no_data' });
});

test('suggestTransfer: among all-available players, the coldest form is picked as the OUT candidate', () => {
  const picks = [pick(1, 3), pick(2, 3), pick(3, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '8.0' }),
    poolPlayer(2, { form: '1.5' }), // coldest -- should be the OUT candidate
    poolPlayer(3, { form: '5.0' }),
    poolPlayer(99, { id: 99, form: '9.0', now_cost: 80 }) // affordable replacement
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.out.player_id, 2, 'The coldest-form available player should be flagged OUT');
});

test('suggestTransfer: availability trumps form -- an unavailable player is picked OUT even over a colder-but-available teammate', () => {
  const picks = [pick(1, 3), pick(2, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '0.5', status: 'a' }),   // very cold but available
    poolPlayer(2, { form: '9.0', status: 'i' }),   // hot form, but injured
    poolPlayer(99, { id: 99, form: '5.0', now_cost: 80 })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.out.player_id, 2, 'Injured status should outweigh hot form entirely');
  assert.strictEqual(result.out.availability_status, 'i');
  assert.match(result.reason, /is injured/);
});

test('suggestTransfer: replacement candidates are constrained to the outgoing player\'s own position', () => {
  const picks = [pick(1, 4)]; // FWD
  const pool = poolFrom([
    poolPlayer(1, { element_type: 4, form: '2.0', now_cost: 80 }),
    poolPlayer(2, { element_type: 4, form: '9.0', now_cost: 80 }), // correct position -- eligible
    poolPlayer(3, { element_type: 3, form: '9.9', now_cost: 80 })  // MID -- wrong position, must be excluded
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 2, 'A MID candidate should never be suggested to replace a FWD');
});

test('suggestTransfer: a candidate above the budget ceiling (out price + bank) is excluded', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { now_cost: 80, form: '2.0' }),   // £8.0m outgoing
    poolPlayer(2, { now_cost: 95, form: '9.0' }),   // £9.5m -- too expensive with 0 bank
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.reason, 'no_affordable_upgrade');
  assert.strictEqual(result.out.player_id, 1);
});

test('suggestTransfer: bank is added to the budget ceiling, making an otherwise-unaffordable candidate valid', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { now_cost: 80, form: '2.0' }),  // £8.0m outgoing
    poolPlayer(2, { now_cost: 95, form: '9.0' }),  // £9.5m -- needs 15 tenths of bank
  ]);
  const result = suggestTransfer(picks, pool, 20); // £2.0m in the bank
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 2);
  assert.strictEqual(result.in.price, 9.5);
});

test('suggestTransfer: already-owned players are never suggested as the replacement', () => {
  const picks = [pick(1, 3), pick(2, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { form: '9.9', now_cost: 80 }), // best-scoring candidate, but already owned
    poolPlayer(3, { form: '5.0', now_cost: 80 })  // should win instead
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 3, 'Player 2 is already on the squad and must be excluded from candidates');
});

test('suggestTransfer: unavailable pool candidates are never suggested as the replacement', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { form: '9.9', now_cost: 80, status: 'd' }), // best score, but doubtful
    poolPlayer(3, { form: '5.0', now_cost: 80, status: 'a' })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 3);
});

test('suggestTransfer: candidate ranking favors higher ep_next (weighted x2) plus form', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { ep_next: '3.0', form: '9.0', now_cost: 80 }),  // score = 6 + 9 = 15
    poolPlayer(3, { ep_next: '8.0', form: '0.0', now_cost: 80 })   // score = 16 + 0 = 16 -- should win
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.in.player_id, 3, 'ep_next is weighted x2, so it should outrank a pure-form candidate here');
});

test('suggestTransfer: a picks/pool mismatch (stale player_id not in the pool) is skipped rather than crashing', () => {
  const picks = [pick(999, 3), pick(2, 3)]; // 999 not in pool at all
  const pool = poolFrom([
    poolPlayer(2, { form: '3.0', now_cost: 80 }),
    poolPlayer(99, { id: 99, form: '9.0', now_cost: 80 })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.out.player_id, 2, 'Player 999 has no pool entry and must be skipped, not crash the whole function');
});

test('suggestTransfer: when every owned player is missing from the pool, returns no_data instead of crashing', () => {
  const picks = [pick(999, 3), pick(998, 3)];
  const pool = poolFrom([poolPlayer(2, { form: '9.0', now_cost: 80 })]);
  const result = suggestTransfer(picks, pool, 0);
  assert.deepStrictEqual(result, { found: false, reason: 'no_data' });
});

test('suggestTransfer: delta_pts and reason reflect the actual ep_next gap and both player names', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80, ep_next: '3.0' }),
    poolPlayer(2, { form: '9.0', now_cost: 80, ep_next: '5.5' })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.delta_pts, 2.5);
  assert.match(result.reason, /Player1/);
  assert.match(result.reason, /Player2/);
  assert.match(result.reason, /has cooled off/, 'An available-but-cold OUT candidate should use the form-based reason phrasing, not an availability one');
});

// ---- handleSquadAdvisor (I/O wrapper) ----

function dynamoRouter({ picksByGw = {}, bankByGw = {}, chipsByEntry = {} } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const ctor = command.constructor.name;

    if (table === 'seasons' && ctor === 'ScanCommand') {
      return { Items: [SEASON_ROW] };
    }
    if (table === 'fpl_entry_picks' && ctor === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':k'];
      return { Items: picksByGw[key] || [] };
    }
    if (table === 'fpl_entry_gameweek' && ctor === 'QueryCommand') {
      const se = command.input.ExpressionAttributeValues[':se'];
      const gw = command.input.ExpressionAttributeValues[':gw'];
      // getBankTenths queries a single gameweek (':gw' present); getUsedChips queries
      // the whole season (no ':gw' at all) -- same table, distinguished by which
      // ExpressionAttributeValues the real KeyConditionExpression actually bound.
      if (gw !== undefined) {
        const bank = bankByGw[`${se}#${gw}`];
        return { Items: typeof bank === 'number' ? [{ bank }] : [] };
      }
      const chips = chipsByEntry[se] || [];
      return { Items: chips.map((active_chip) => ({ active_chip })) };
    }
    return undefined;
  };
}

function bootstrapFetchMock(elements) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ elements }));
    }
    return null;
  });
}

test('handleSquadAdvisor: missing entry_id returns 400 without touching the database', async () => {
  const dynamoMock = installDynamoMock(() => {
    throw new Error('Should not query DynamoDB when entry_id is missing');
  });

  try {
    const response = await handleSquadAdvisor({}, CORS);
    assert.strictEqual(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.match(body.error, /entry_id/);
  } finally {
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: no picks + preseason returns transfer.reason "season_not_started"', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: false, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '1' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.found, false);
    assert.strictEqual(body.transfer.reason, 'season_not_started');
    assert.deepStrictEqual(body.used_chips, [], 'used_chips is fetched independently of picks, and should still come back (empty here)');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: no picks + season live returns transfer.reason "no_data"', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: true, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '1' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.found, false);
    assert.strictEqual(body.transfer.reason, 'no_data');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: full success -- fetches live pool + bank and returns a real found:true suggestion', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 },
    { player_id: 6, player_name: 'Salah', player_position: 3, squad_position: 6, player_team: 14 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 5, web_name: 'Saka', element_type: 3, now_cost: 100, form: '1.0', ep_next: '2.0', status: 'a', selected_by_percent: '30.0' },
    { id: 6, web_name: 'Salah', element_type: 3, now_cost: 130, form: '8.0', ep_next: '7.0', status: 'a', selected_by_percent: '40.0' },
    { id: 50, web_name: 'ReplacementMid', element_type: 3, now_cost: 105, form: '9.0', ep_next: '8.0', status: 'a', selected_by_percent: '5.0' }
  ]);
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks },
    bankByGw: { '2026/27#728477#5': 5 }, // £0.5m bank -> 5 tenths
    chipsByEntry: { '2026/27#728477': ['bboost'] }
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.season, '2026/27');
    assert.strictEqual(body.gameweek, 5);
    assert.strictEqual(body.transfer.found, true);
    assert.strictEqual(body.transfer.out.player_id, 5, 'Saka has the coldest form (1.0) of the two -- should be the OUT candidate');
    assert.strictEqual(body.transfer.in.player_id, 50, 'ReplacementMid is the only affordable, unowned MID candidate');
    assert.ok(body.transfer.delta_pts > 0);
    assert.deepStrictEqual(body.used_chips, ['bboost']);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: used_chips collects distinct chips played across every gameweek this season', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 5, web_name: 'Saka', element_type: 3, now_cost: 100, form: '5.0', ep_next: '5.0', status: 'a' }
  ]);
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks },
    // Same chip appearing on more than one row (e.g. a re-synced row) should still
    // dedupe to a single entry -- 'wildcard' repeated plus '3xc' once should give
    // exactly 2 distinct chips back, not 3.
    chipsByEntry: { '2026/27#728477': ['wildcard', 'wildcard', '3xc'] }
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.used_chips.length, 2, 'Should dedupe the repeated wildcard entry');
    assert.ok(body.used_chips.includes('wildcard'));
    assert.ok(body.used_chips.includes('3xc'));
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: used_chips fails open to an empty array if the chip-history query errors', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 5, web_name: 'Saka', element_type: 3, now_cost: 100, form: '5.0', ep_next: '5.0', status: 'a' }
  ]);
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const ctor = command.constructor.name;
    if (table === 'seasons' && ctor === 'ScanCommand') return { Items: [SEASON_ROW] };
    if (table === 'fpl_entry_picks' && ctor === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':k'];
      return { Items: key === '2026/27#728477#5' ? picks : [] };
    }
    if (table === 'fpl_entry_gameweek' && ctor === 'QueryCommand') {
      const gw = command.input.ExpressionAttributeValues[':gw'];
      if (gw !== undefined) return { Items: [] }; // bank query -- fine
      throw new Error('DynamoDB unavailable'); // used-chips query -- simulate a failure
    }
    return undefined;
  });

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    assert.strictEqual(response.statusCode, 200, 'A failed chip-history query should never surface as a 500');
    const body = JSON.parse(response.body);
    assert.deepStrictEqual(body.used_chips, []);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: a live pool fetch failure fails open to no_data rather than a 500', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 }
  ];
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse({}, { ok: false, status: 500 });
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks }
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    assert.strictEqual(response.statusCode, 200, 'A failed live-pool fetch should never surface as a 500');
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.found, false);
    assert.strictEqual(body.transfer.reason, 'no_data');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

// ---- Route ordering (index.mjs) ----
//
// '/manager-squad/advisor' also contains '/manager-squad' as a substring, so the more
// specific advisor route must be checked BEFORE the plain squad route or every advisor
// request would silently fall through to handleManagerSquad instead (wrong shape
// response: `players`, no `transfer` field at all).

function apiEvent(path, queryStringParameters) {
  return { httpMethod: 'GET', path, queryStringParameters };
}

test('index.mjs: /manager-squad/advisor dispatches to handleSquadAdvisor, not handleManagerSquad', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: true, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handler(apiEvent('/manager-squad/advisor', { entry_id: '728477', gw: '1' }));
    const body = JSON.parse(response.body);
    assert.ok('transfer' in body, 'Expected the advisor response shape (a `transfer` key)');
    assert.ok(!('players' in body), 'Should not have fallen through to the plain squad response shape');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('index.mjs: plain /manager-squad still dispatches to handleManagerSquad', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: true, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handler(apiEvent('/manager-squad', { entry_id: '728477', gw: '1' }));
    const body = JSON.parse(response.body);
    assert.ok('players' in body, 'Expected the plain squad response shape (a `players` key)');
    assert.ok(!('transfer' in body), 'Plain /manager-squad should never return the advisor shape');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
