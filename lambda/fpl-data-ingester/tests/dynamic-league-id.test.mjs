// EVAL: LEAGUE_ID resolution in index.mjs
//
// Bug: LEAGUE_ID is a hardcoded module-level constant. When the real league ID
// changed for the 2026/27 season (212889 -> 438107, confirmed live 2026-07-30),
// fixing it required a code change + redeploy -- the same "hardcoded literal with
// nothing to remind you to update it" pattern that caused the original season-string
// bug and the getCurrentSeason() season_id/season_string incident.
//
// Fix: the current league's ID should live on the `seasons` table row (same place
// season_string already lives), so a league-ID change becomes a data update instead
// of a code change + redeploy.
//
// Run BEFORE the fix: expect FAIL on the "current bug" test.
// Run AFTER the fix: expect all tests to PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

function installFetchMockCapturingLeagueUrl() {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    }
    if (url.includes('leagues-classic')) {
      return jsonResponse({ standings: { results: [] }, new_entries: { results: [] } });
    }
    if (url.includes('/picks/')) return jsonResponse({ entry_history: { points: 0 }, picks: [] });
    return null;
  });
}

test('[current bug] fetches the league ID from the seasons table, not a hardcoded constant', async () => {
  const fetchMock = installFetchMockCapturingLeagueUrl();
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      // A league ID that does NOT match whatever's hardcoded in index.mjs.
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true, league_id: 999999 }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') return { Items: [] };
    return undefined;
  });

  try {
    await handler({});

    const leagueCall = fetchMock.calls.find((c) => c.url.includes('leagues-classic'));
    assert.ok(leagueCall, 'Expected a call to the leagues-classic endpoint');
    assert.ok(leagueCall.url.includes('999999'), `Expected the league ID from the seasons table (999999) to ` +
      `be used in the request URL, got "${leagueCall.url}". This means LEAGUE_ID is still a hardcoded constant ` +
      `instead of being resolved from the seasons table.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] fails loudly if the current season row has no league_id set, instead of silently using a stale value', async () => {
  const fetchMock = installFetchMockCapturingLeagueUrl();
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      // No league_id field at all -- simulates a season row that hasn't been migrated yet.
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    return undefined;
  });

  try {
    const result = await handler({});
    const body = JSON.parse(result.body);
    assert.strictEqual(body.success, false, 'Expected the handler to report failure, not silently proceed ' +
      'with an undefined or stale league ID');
    assert.match(body.error, /league_id/i, `Expected the error message to mention the missing league_id, got: ${body.error}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
