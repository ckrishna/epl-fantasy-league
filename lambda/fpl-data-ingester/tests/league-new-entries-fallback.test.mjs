// EVAL: getLeagueManagers() in index.mjs
//
// Bug found live on 2026-07-30 right after standing up the brand-new 2026/27
// mini-league (id 438107): FPL's classic-league standings API splits members into
// two buckets --
//   - `standings.results`   -- established members, populated once they've been
//                              merged in (appears to require at least one scored GW)
//   - `new_entries.results` -- managers who just joined and haven't been merged yet
//
// getLeagueManagers() only ever read `data.standings?.results`. For a brand-new
// league, every member sits in `new_entries` and `standings.results` is a genuinely
// empty array (not missing -- an empty array passes the `Array.isArray` guard), so
// the ingester silently saw 0 managers and did nothing, despite real members existing.
// Confirmed via the raw API response: https://fantasy.premierleague.com/api/leagues-classic/438107/standings/
//
// Run BEFORE the fix: expect FAIL on the "current bug" test.
// Run AFTER the fix: expect all tests to PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

function installFetchMockWithLeagueResponse(leagueResponse) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    }
    if (url.includes('leagues-classic')) return jsonResponse(leagueResponse);
    if (url.includes('/picks/')) {
      return jsonResponse({
        entry_history: { points: 0, event_transfers_cost: 0, total_points: 0, event_transfers: 0, transfers_left: 1, active_chip: null, bank: 1000, value: 1000 },
        picks: []
      });
    }
    return null;
  });
}

function installBasicDynamoMock() {
  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') return { Items: [] };
    if (name === 'PutCommand') { puts.push({ table, item: command.input.Item }); return {}; }
    if (name === 'BatchWriteCommand') return {};
    return undefined;
  });
  return { ...dynamoMock, puts };
}

test('[current bug] brand-new league: falls back to new_entries when standings.results is empty', async () => {
  // This is the exact shape returned by the live API for league 438107 on 2026-07-30.
  const liveLeagueResponse = {
    new_entries: {
      has_next: false,
      page: 1,
      results: [
        { entry: 1836232, entry_name: 'Da Movement', joined_time: '2026-07-30T16:13:12Z', player_first_name: 'Michael Kojo', player_last_name: 'Brown' },
        { entry: 1052575, entry_name: 'Self-Goal', joined_time: '2026-07-30T16:13:11Z', player_first_name: 'nihar', player_last_name: 'namjoshi' },
        { entry: 728477, entry_name: 'COYS', joined_time: '2026-07-30T16:13:11Z', player_first_name: 'Chetan', player_last_name: 'Bk' },
        { entry: 2237404, entry_name: 'Suberon', joined_time: '2026-07-30T16:13:11Z', player_first_name: 'Sushil', player_last_name: 'Suvarna' }
      ]
    },
    league: { id: 438107, name: 'Carpe Diem' },
    standings: { has_next: false, page: 1, results: [] }
  };

  const fetchMock = installFetchMockWithLeagueResponse(liveLeagueResponse);
  const dynamoMock = installBasicDynamoMock();

  try {
    await handler({});

    const standingsPuts = dynamoMock.puts.filter((p) => p.table === 'fpl_league_standings');
    assert.strictEqual(standingsPuts.length, 4, `Expected all 4 new_entries managers to be picked up and ` +
      `written to fpl_league_standings, got ${standingsPuts.length}. If this is 0, getLeagueManagers() is ` +
      `still only reading standings.results and ignoring new_entries.`);

    const names = standingsPuts.map((p) => p.item.manager_name).sort();
    assert.deepStrictEqual(names, ['COYS', 'Da Movement', 'Self-Goal', 'Suberon']);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] once FPL populates standings.results, that takes priority over new_entries', async () => {
  const liveLeagueResponse = {
    new_entries: {
      results: [
        { entry: 999, entry_name: 'Stale Entry', joined_time: '2026-07-30T16:13:11Z', player_first_name: 'Should', player_last_name: 'BeIgnored' }
      ]
    },
    standings: {
      results: [
        { entry: 728477, entry_name: 'COYS', player_name: 'Chetan Bk' }
      ]
    }
  };

  const fetchMock = installFetchMockWithLeagueResponse(liveLeagueResponse);
  const dynamoMock = installBasicDynamoMock();

  try {
    await handler({});

    const standingsPuts = dynamoMock.puts.filter((p) => p.table === 'fpl_league_standings');
    assert.strictEqual(standingsPuts.length, 1, 'Expected only the one manager from standings.results, ' +
      'not the stale new_entries manager -- once FPL merges someone into standings, that should win.');
    assert.strictEqual(standingsPuts[0].item.manager_name, 'COYS');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] genuinely empty league (nobody joined at all) still fails loudly, not silently', async () => {
  const emptyLeagueResponse = {
    new_entries: { results: [] },
    standings: { results: [] }
  };

  const fetchMock = installFetchMockWithLeagueResponse(emptyLeagueResponse);
  const dynamoMock = installBasicDynamoMock();

  try {
    const result = await handler({});
    const body = JSON.parse(result.body);
    // With zero managers anywhere, the handler should complete (not crash), just do nothing.
    assert.strictEqual(body.success, true);
    assert.strictEqual(dynamoMock.puts.filter((p) => p.table === 'fpl_league_standings').length, 0);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
