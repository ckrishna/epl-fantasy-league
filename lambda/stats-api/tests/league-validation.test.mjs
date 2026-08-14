// League onboarding validation (utils/league-validation.mjs) -- the three checks that
// must pass before scripts/add-league.mjs registers a new league_id: exists & is open,
// not already registered for the current season, and is under the size cap.
//
// Background for the "duplicate" tests: FPL recycles league_id values across seasons
// (confirmed live 2026-08-14 -- see league-validation.mjs's file header), so the
// duplicate check must be scoped to (league_id, season), never league_id alone.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installFetchMock, jsonResponse } from './helpers/mock-fetch.mjs';
import { validateLeagueForOnboarding } from '../utils/league-validation.mjs';

function seasonsRouter() {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'leagues' && type === 'GetCommand') return { Item: undefined };
    return undefined;
  };
}

function standingsPage({
  leagueName = 'Carpe Diem',
  closed = false,
  standingsResults = [],
  standingsHasNext = false,
  newEntriesResults = [],
  newEntriesHasNext = false
} = {}) {
  return {
    league: { id: 438107, name: leagueName, created: '2026-07-30T16:13:11.797517Z', closed },
    standings: { results: standingsResults, has_next: standingsHasNext },
    new_entries: { results: newEntriesResults, has_next: newEntriesHasNext }
  };
}

function entries(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ entry: offset + i + 1 }));
}

test('happy path: small, open, current-season league not yet registered', async () => {
  const fetchMock = installFetchMock((url) => {
    assert.ok(url.includes('leagues-classic/438107/standings'));
    return jsonResponse(standingsPage({ newEntriesResults: entries(8) }));
  });
  const dynamoMock = installDynamoMock(seasonsRouter());

  const result = await validateLeagueForOnboarding(438107);

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.league.name, 'Carpe Diem');
  assert.strictEqual(result.league.entryCount, 8);
  assert.strictEqual(result.league.season, '2026/27');

  fetchMock.restore();
  dynamoMock.restore();
});

test('rejects a league already registered for the current season', async () => {
  const fetchMock = installFetchMock(() =>
    jsonResponse(standingsPage({ newEntriesResults: entries(8) }))
  );
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'leagues' && type === 'GetCommand') {
      return { Item: { league_id: 438107, season_string: '2026/27', added_at: '2026-08-01T00:00:00.000Z' } };
    }
    return undefined;
  });

  const result = await validateLeagueForOnboarding(438107);

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('already registered')));

  fetchMock.restore();
  dynamoMock.restore();
});

test('rejects a league FPL has marked closed', async () => {
  const fetchMock = installFetchMock(() =>
    jsonResponse(standingsPage({ closed: true, newEntriesResults: entries(3) }))
  );
  const dynamoMock = installDynamoMock(seasonsRouter());

  const result = await validateLeagueForOnboarding(438107);

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('closed')));

  fetchMock.restore();
  dynamoMock.restore();
});

test('rejects a league over the size cap without paging it to completion', async () => {
  let pagesFetched = 0;
  const fetchMock = installFetchMock((url) => {
    pagesFetched += 1;
    const page = Number(new URL(url).searchParams.get('page_standings'));
    // 3 entries per page, always has_next -- would run forever if not capped early.
    return jsonResponse(standingsPage({ standingsResults: entries(3, (page - 1) * 3), standingsHasNext: true }));
  });
  const dynamoMock = installDynamoMock(seasonsRouter());

  const result = await validateLeagueForOnboarding(438107, { maxEntries: 5 });

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('too large to onboard')));
  // cap is 5, 3 per page -> should exceed and bail after page 2 (6 > 5), not page 100+.
  assert.ok(pagesFetched <= 3, `expected an early bailout, fetched ${pagesFetched} pages`);

  fetchMock.restore();
  dynamoMock.restore();
});

test('falls back to new_entries when standings is empty (brand-new league)', async () => {
  const fetchMock = installFetchMock(() =>
    jsonResponse(standingsPage({ standingsResults: [], newEntriesResults: entries(4) }))
  );
  const dynamoMock = installDynamoMock(seasonsRouter());

  const result = await validateLeagueForOnboarding(438107);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.league.entryCount, 4);

  fetchMock.restore();
  dynamoMock.restore();
});

test('reports "not found" for a 404 without touching DynamoDB', async () => {
  const fetchMock = installFetchMock(() => jsonResponse({}, { ok: false, status: 404 }));
  const dynamoMock = installDynamoMock(() => {
    throw new Error('should not query DynamoDB when the league does not exist');
  });

  const result = await validateLeagueForOnboarding(9999999);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.league, null);
  assert.ok(result.errors[0].includes('No league found'));

  fetchMock.restore();
  dynamoMock.restore();
});

test('rejects a non-numeric id without making any network call', async () => {
  const fetchMock = installFetchMock(() => {
    throw new Error('should not fetch for an invalid id');
  });

  const result = await validateLeagueForOnboarding('not-a-number');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(fetchMock.calls.length, 0);

  fetchMock.restore();
});
