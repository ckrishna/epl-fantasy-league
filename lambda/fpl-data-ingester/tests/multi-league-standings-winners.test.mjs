// EVAL: handler() writes one fpl_league_standings row PER LEAGUE a manager belongs to,
// and computes gw-winners-cache winners PER LEAGUE (task #48), instead of assuming every
// manager ingested this run belongs to exactly one league.
//
// Before this fix, the ingester only ever fetched ONE league (seasons.league_id) and
// wrote ONE standings/winners row per (season+gw, manager)/(season, gw) -- correct for
// a single league, but a manager belonging to TWO leagues (real scenario: an FPL entry
// shared between Carpe Diem and a second league this season) would have their single
// fpl_league_standings row silently overwritten by whichever league synced last, and
// gw-winners-cache would only ever reflect one league's winner even though the two
// leagues can have genuinely different winners for the same gameweek (different
// rosters -> different max score).
//
// Fixed by: resolving every registered league for the season (seasons.league_id plus
// anything in the `leagues` table), fetching each league's roster, deduping managers by
// entry_id for the shared gameweek/picks fetch (no duplicate FPL API calls for a shared
// manager), then writing standings with the new composite league_manager key
// ("{league_id}#{entry_id}") and computing winners independently per league using the
// new composite gameweek_league key ("{gw}#{league_id}") -- see
// migrate-composite-standings-key.mjs for the schema migration this depends on.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const LEAGUE_A = 438107; // "Carpe Diem" -- the season's primary league_id
const LEAGUE_B = 616920; // a second, separately-registered league

// entry 101 ("Da Movement") is deliberately a member of BOTH leagues -- the real
// scenario that prompted this fix. entry 102 ("Suberox") is League A-only; entry 201
// ("BetsGuy") is League B-only.
const LEAGUE_A_MANAGERS = [
  { entry: 101, entry_name: 'Da Movement', player_name: 'Michael Kojo Brown' },
  { entry: 102, entry_name: 'Suberox', player_name: 'Yash Thakker' }
];
const LEAGUE_B_MANAGERS = [
  { entry: 101, entry_name: 'Da Movement', player_name: 'Michael Kojo Brown' },
  { entry: 201, entry_name: 'BetsGuy', player_name: 'Someone Else' }
];

// Distinct points_this_week per manager so each league's winner is genuinely different
// -- League A's max is Da Movement (60 > 50), League B's max is BetsGuy (70 > 60). If
// winners were ever computed once across a pooled/unscoped manager list instead of per
// league, League A would incorrectly show BetsGuy (the highest scorer overall) as its
// winner too.
const POINTS_BY_ENTRY = { 101: 60, 102: 50, 201: 70 };

function picksResponseFor(entryId) {
  return jsonResponse({
    active_chip: null,
    entry_history: {
      points: POINTS_BY_ENTRY[entryId], event_transfers_cost: 0, total_points: 1000,
      event_transfers: 0, transfers_left: 1, bank: 5, value: 1000
    },
    picks: []
  });
}

function installMultiLeagueFetchMock() {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 5), elements: [] }));
    if (url.includes(`leagues-classic/${LEAGUE_A}`)) return jsonResponse({ standings: { results: LEAGUE_A_MANAGERS } });
    if (url.includes(`leagues-classic/${LEAGUE_B}`)) return jsonResponse({ standings: { results: LEAGUE_B_MANAGERS } });
    if (url.includes('/event/') && url.includes('/live/')) return jsonResponse({ elements: [] });
    if (url.includes('/entry/101/')) return picksResponseFor(101);
    if (url.includes('/entry/102/')) return picksResponseFor(102);
    if (url.includes('/entry/201/')) return picksResponseFor(201);
    return null;
  });
}

// Tracks how many times each unique entry_id's picks endpoint was actually called --
// the regression check for "a shared manager's data is fetched once, not once per
// league they're in".
function picksCallCountByEntry(fetchMock) {
  const counts = {};
  for (const call of fetchMock.calls) {
    const match = call.url.match(/\/entry\/(\d+)\/event\/\d+\/picks\//);
    if (match) counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  return counts;
}

function installMultiLeagueDynamoMock() {
  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;

    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true, league_id: LEAGUE_A }] };
    }
    if (table === 'leagues' && type === 'ScanCommand') {
      return { Items: [{ league_id: LEAGUE_B, season_string: '2025/26', status: 'active', name: 'BETSBANTSSPORT' }] };
    }
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      // Two different Scan shapes hit this table: the winners step scans the whole
      // season ("season = :s"), the standings step scans one manager at a time
      // ("season_entry = :se"). Route by which ExpressionAttributeValues key is
      // present, same way the real FilterExpressions differ.
      const values = command.input.ExpressionAttributeValues || {};
      if (values[':se']) {
        // Per-manager latest-record lookup for standings. Reconstruct just enough of
        // what storeGameweekSummary would have written this run for that one entry_id.
        const entryId = Number(String(values[':se']).split('#')[1]);
        return {
          Items: [{
            season_entry: values[':se'], gameweek: 1, entry_id: entryId, season: '2025/26',
            points_this_week: POINTS_BY_ENTRY[entryId], points_total: POINTS_BY_ENTRY[entryId], transfer_cost: 0
          }]
        };
      }
      // Season-wide scan for the winners step -- every manager processed this run,
      // regardless of league (mirrors what storeGameweekSummary actually wrote).
      return {
        Items: Object.entries(POINTS_BY_ENTRY).map(([entryId, points]) => ({
          season: '2025/26', gameweek: 1, entry_id: Number(entryId),
          points_this_week: points, transfer_cost: 0
        }))
      };
    }
    if (type === 'PutCommand') { puts.push({ table, item: command.input.Item }); return {}; }
    if (type === 'BatchWriteCommand') return {};
    return undefined;
  });
  return { ...dynamoMock, puts };
}

test('a manager shared between two leagues gets one fpl_league_standings row PER LEAGUE, not one overwritten row', async () => {
  const fetchMock = installMultiLeagueFetchMock();
  const dynamoMock = installMultiLeagueDynamoMock();

  try {
    const response = await handler({});
    assert.strictEqual(JSON.parse(response.body).success, true);

    const standingsPuts = dynamoMock.puts.filter((p) => p.table === 'fpl_league_standings');
    const keys = standingsPuts.map((p) => p.item.league_manager).sort();
    assert.deepStrictEqual(keys, [
      `${LEAGUE_A}#101`, `${LEAGUE_A}#102`, `${LEAGUE_B}#101`, `${LEAGUE_B}#201`
    ].sort(), 'Expected 4 standings rows -- Da Movement (101) gets one per league, Suberox and BetsGuy get exactly one each');

    const daMovementRows = standingsPuts.filter((p) => p.item.manager_id === 101);
    assert.strictEqual(daMovementRows.length, 2, 'The shared manager must get two separate rows, not one row whose league_id got overwritten');
    assert.deepStrictEqual(daMovementRows.map((p) => p.item.league_id).sort(), [LEAGUE_A, LEAGUE_B].sort());
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('a shared manager\'s picks/gameweek data is fetched exactly once, not once per league they belong to', async () => {
  const fetchMock = installMultiLeagueFetchMock();
  const dynamoMock = installMultiLeagueDynamoMock();

  try {
    await handler({});
    const counts = picksCallCountByEntry(fetchMock);
    assert.strictEqual(counts['101'], 1, 'Da Movement (in both leagues) should still only be fetched once');
    assert.strictEqual(counts['102'], 1);
    assert.strictEqual(counts['201'], 1);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('winners are computed independently per league, not from a pooled/unscoped manager list', async () => {
  const fetchMock = installMultiLeagueFetchMock();
  const dynamoMock = installMultiLeagueDynamoMock();

  try {
    await handler({});

    const winnersPuts = dynamoMock.puts.filter((p) => p.table === 'gw-winners-cache');
    assert.strictEqual(winnersPuts.length, 2, 'Expected one winners row per (gameweek, league) -- GW1 x 2 leagues');

    const leagueAWinners = winnersPuts.find((p) => p.item.league_id === LEAGUE_A);
    const leagueBWinners = winnersPuts.find((p) => p.item.league_id === LEAGUE_B);

    assert.strictEqual(leagueAWinners.item.gameweek_league, `1#${LEAGUE_A}`);
    assert.strictEqual(leagueAWinners.item.winners.length, 1);
    assert.strictEqual(leagueAWinners.item.winners[0].entry_id, 101, 'League A\'s winner is Da Movement (60 > Suberox\'s 50) -- BetsGuy (70) isn\'t even in this league\'s roster');

    assert.strictEqual(leagueBWinners.item.gameweek_league, `1#${LEAGUE_B}`);
    assert.strictEqual(leagueBWinners.item.winners.length, 1);
    assert.strictEqual(leagueBWinners.item.winners[0].entry_id, 201, 'League B\'s winner is BetsGuy (70 > Da Movement\'s 60)');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] with no leagues table rows at all, behavior is identical to single-league ingestion', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 5), elements: [] }));
    if (url.includes(`leagues-classic/${LEAGUE_A}`)) return jsonResponse({ standings: { results: LEAGUE_A_MANAGERS } });
    if (url.includes('/event/') && url.includes('/live/')) return jsonResponse({ elements: [] });
    if (url.includes('/entry/101/')) return picksResponseFor(101);
    if (url.includes('/entry/102/')) return picksResponseFor(102);
    return null;
  });
  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true, league_id: LEAGUE_A }] };
    }
    if (table === 'leagues' && type === 'ScanCommand') return { Items: [] }; // nothing registered beyond the primary league
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      const values = command.input.ExpressionAttributeValues || {};
      if (values[':se']) {
        const entryId = Number(String(values[':se']).split('#')[1]);
        return { Items: [{ season_entry: values[':se'], gameweek: 1, entry_id: entryId, season: '2025/26', points_this_week: POINTS_BY_ENTRY[entryId], points_total: POINTS_BY_ENTRY[entryId], transfer_cost: 0 }] };
      }
      return { Items: [{ season: '2025/26', gameweek: 1, entry_id: 101, points_this_week: 60, transfer_cost: 0 }, { season: '2025/26', gameweek: 1, entry_id: 102, points_this_week: 50, transfer_cost: 0 }] };
    }
    if (type === 'PutCommand') { puts.push({ table, item: command.input.Item }); return {}; }
    if (type === 'BatchWriteCommand') return {};
    return undefined;
  });

  try {
    await handler({});
    const standingsPuts = puts.filter((p) => p.table === 'fpl_league_standings');
    assert.strictEqual(standingsPuts.length, 2, 'One row per manager, same as before -- no manager belongs to a second league here');
    assert.deepStrictEqual(standingsPuts.map((p) => p.item.league_manager).sort(), [`${LEAGUE_A}#101`, `${LEAGUE_A}#102`].sort());

    const winnersPuts = puts.filter((p) => p.table === 'gw-winners-cache');
    assert.strictEqual(winnersPuts.length, 1, 'One winners row for GW1, same as before -- only one league in play');
    assert.strictEqual(winnersPuts[0].item.gameweek_league, `1#${LEAGUE_A}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
