// EVAL: Trends tab -- handlers/trends.mjs + utils/trends-data.mjs.
//
// Covers: the manager picker (dedupes by real name across seasons, nickname fallback),
// the pace-vs-history computation (per-gameweek average/min/max envelope, "ahead of/
// behind your average" diff at the current gameweek), the season-by-season summary
// (final points/rank, GW10 rank, is_current flag), rank computation against peers
// (not just the requested manager's own numbers), and the missing-manager 404.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { handleTrends, handleTrendsManagers } from '../handlers/trends.mjs';

const SEASON_PAST = '2024/25';
const SEASON_CURRENT = '2025/26';

// handleTrendsManagers sources the current roster the exact same way handleStandings()
// does: getActiveGameweek() (a live bootstrap-static fetch, mocked here) +
// queryLeagueStandings() against fpl_league_standings, which the ingester populates
// from the live FPL roster on every run. `names` becomes each row's `real_name` --
// the field the ingester actually writes (see index.mjs's fpl_league_standings
// PutCommand), at the gameweek reported as current.
function mockActiveGwFetch(gw = 6) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(gw, 38) }));
    }
    return null;
  });
}

function standingsRow(real_name, { gw = 6, team_nickname = null } = {}) {
  return { season_event: `${SEASON_CURRENT}#${gw}`, real_name, team_nickname, total_points: 0, points_this_week: 0, transfer_cost: 0 };
}

function gwRow({ season, entry_id, gameweek, points_total, real_name, team_nickname = null }) {
  return {
    season_entry: `${season}#${entry_id}`,
    gameweek,
    entry_id,
    season,
    real_name,
    team_nickname,
    points_total,
    points_this_week: 50,
    transfer_cost: 0
  };
}

// Three managers, one past season (full 12 GWs, Alice and Bob only) and one current
// season through GW6 (Alice and Carol), so both the historical-envelope logic and the
// "vs the field" worm-graph logic have something real to chew on. Alice is ahead of
// her own history at the current GW and is also this season's leader; Bob has no
// live-season row at all (only ever played the historical season), to exercise that
// edge case; Carol only exists in the current season, to exercise the field/worm
// output having a manager with no historical seasons at all.
function buildFixtureRows() {
  const rows = [];
  for (let gw = 1; gw <= 12; gw++) {
    rows.push(gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: gw, points_total: gw * 50, real_name: 'Alice Smith' }));
    rows.push(gwRow({ season: SEASON_PAST, entry_id: 2, gameweek: gw, points_total: gw * 40, real_name: 'Bob Jones' }));
  }
  for (let gw = 1; gw <= 6; gw++) {
    rows.push(gwRow({ season: SEASON_CURRENT, entry_id: 1, gameweek: gw, points_total: gw * 60, real_name: 'Alice Smith', team_nickname: "Alice's Aces" }));
    rows.push(gwRow({ season: SEASON_CURRENT, entry_id: 3, gameweek: gw, points_total: gw * 45, real_name: 'Carol White', team_nickname: "Carol's Crew" }));
  }
  return rows;
}

// `standingsAtGw` is a Map of gameweek -> array of standings rows, used only by
// queryLeagueStandings() (i.e. only exercised by handleTrendsManagers). Tests that
// don't touch the manager picker can omit it entirely.
//
// `groupSeasonRows` backs the `group_seasons` table (utils/group-seasons.mjs) -- only
// consulted at all when a test passes a `league_id` query param through handleTrends;
// every pre-existing test omits it entirely, and getAllowedSeasonsForLeague() returns
// null (no scoping) without ever touching DynamoDB when leagueId is null, so this is a
// pure addition that changes nothing for tests that don't opt in.
//
// `rosterRows` backs getLeagueRoster's per-season fpl_league_standings scan (GH #49's
// roster-level scoping, layered on top of allowedSeasons/group_seasons above) -- rows
// shaped like fpl_league_standings items (season_event/manager_id/league_id). Omit for
// tests that don't opt into a league_id, same reasoning as groupSeasonRows.
//
// `groupName` backs the `groups` table GetCommand (getGroupNameForLeagueId) -- also only
// consulted when a league_id resolves to a real group.
function mockScan(rows, standingsAtGw = new Map(), groupSeasonRows = [], rosterRows = [], groupName = null) {
  return installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'fpl_entry_gameweek') {
      return { Items: rows };
    }
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'seasons') {
      return { Items: [{ season_string: SEASON_CURRENT, season_id: 2, current: true }] };
    }
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'fpl_league_standings') {
      const key = command.input.ExpressionAttributeValues[':se'];
      for (const [gw, items] of standingsAtGw) {
        if (key === `${SEASON_CURRENT}#${gw}`) return { Items: items };
      }
      return { Items: [] };
    }
    // getLeagueRoster's per-season scan (begins_with season_event, "{season}#").
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'fpl_league_standings') {
      const prefix = command.input.ExpressionAttributeValues[':prefix'];
      return { Items: rosterRows.filter((r) => r.season_event.startsWith(prefix)) };
    }
    // getGroupIdForLeagueId's reverse lookup (Scan, filtered by league_id).
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'group_seasons') {
      const lid = command.input.ExpressionAttributeValues[':lid'];
      return { Items: groupSeasonRows.filter((r) => r.league_id === lid) };
    }
    // getAllowedSeasonsForLeague's / getSeasonLeagueIdsForGroup's follow-up (Query, by
    // the resolved group_id).
    if (command.constructor.name === 'QueryCommand' && command.input.TableName === 'group_seasons') {
      const groupId = command.input.ExpressionAttributeValues[':g'];
      return { Items: groupSeasonRows.filter((r) => r.group_id === groupId) };
    }
    // getGroupNameForLeagueId's lookup.
    if (command.constructor.name === 'GetCommand' && command.input.TableName === 'groups') {
      return { Item: groupName ? { group_id: command.input.Key.group_id, name: groupName } : undefined };
    }
    return undefined;
  });
}

test('handleTrendsManagers dedupes by real name and fills in a nickname when one exists', async () => {
  const dynamoMock = mockScan(buildFixtureRows(), new Map([[6, [
    standingsRow('Alice Smith', { team_nickname: "Alice's Aces" }),
    standingsRow('Carol White', { team_nickname: "Carol's Crew" })
  ]]]));
  const fetchMock = mockActiveGwFetch(6);
  try {
    const result = await handleTrendsManagers({}, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    // Alice and Carol are both in fpl_league_standings at the current gameweek; Bob
    // only ever played the past season and never rejoined, so he's excluded (see next
    // test).
    assert.strictEqual(body.managers.length, 2);
    const alice = body.managers.find((m) => m.real_name === 'Alice Smith');
    assert.strictEqual(alice.team_nickname, "Alice's Aces");
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrendsManagers excludes a manager not in the current fpl_league_standings roster', async () => {
  // Bob has current-season fpl_entry_gameweek rows in this fixture (unlike the past
  // version of this test), but the fpl_league_standings roster below doesn't include
  // him -- e.g. he played last season but quietly didn't rejoin. The picker should
  // trust the same source Standings itself trusts, since ingested gameweek data alone
  // can't see a drop-out at all.
  const dynamoMock = mockScan(buildFixtureRows(), new Map([[6, [standingsRow('Alice Smith'), standingsRow('Carol White')]]]));
  const fetchMock = mockActiveGwFetch(6);
  try {
    const result = await handleTrendsManagers({}, {});
    const body = JSON.parse(result.body);
    const bob = body.managers.find((m) => m.real_name === 'Bob Jones');
    assert.strictEqual(bob, undefined);
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrendsManagers includes a manager who is on the roster but has zero fpl_entry_gameweek rows', async () => {
  // Regression: caught live -- a manager brand new to the league this season (in the
  // fpl_league_standings roster, but with no gameweek history anywhere yet, since they
  // haven't played a gameweek) was silently dropped by an earlier version of this
  // function that built the list by walking fpl_entry_gameweek and merely checking
  // roster membership -- nothing ever created an entry for a name that was never in
  // that scan to begin with. The fix builds the list directly from fpl_league_standings
  // instead, which has no such dependency.
  const dynamoMock = mockScan(buildFixtureRows(), new Map([[6, [
    standingsRow('Alice Smith', { team_nickname: "Alice's Aces" }),
    standingsRow('Carol White', { team_nickname: "Carol's Crew" }),
    standingsRow('Dana Newcomer', { team_nickname: 'Fresh Start FC' })
  ]]]));
  const fetchMock = mockActiveGwFetch(6);
  try {
    const result = await handleTrendsManagers({}, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(body.managers.length, 3);
    const dana = body.managers.find((m) => m.real_name === 'Dana Newcomer');
    assert.ok(dana, 'Expected a brand-new roster member with no gameweek history to still appear in the picker');
    assert.strictEqual(dana.team_nickname, 'Fresh Start FC');
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrendsManagers walks back a gameweek if fpl_league_standings has a gap at the resolved gameweek', async () => {
  // Mirrors handleStandings()'s own regression test: the active gameweek (6) has no
  // cached standings row (a one-off gap), but GW5 does -- the picker should still
  // resolve the roster via GW5 rather than coming back empty.
  const dynamoMock = mockScan(buildFixtureRows(), new Map([[5, [
    standingsRow('Alice Smith', { gw: 5 }),
    standingsRow('Carol White', { gw: 5 })
  ]]]));
  const fetchMock = mockActiveGwFetch(6);
  try {
    const result = await handleTrendsManagers({}, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.managers.length, 2);
    assert.ok(body.managers.some((m) => m.real_name === 'Alice Smith'));
    assert.ok(body.managers.some((m) => m.real_name === 'Carol White'));
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrendsManagers collapses whitespace variants of the same name', async () => {
  const rows = [
    gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: 1, points_total: 50, real_name: 'Chetan Bk' }),
    gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: 2, points_total: 100, real_name: 'Chetan Bk' }),
    gwRow({ season: SEASON_CURRENT, entry_id: 1, gameweek: 1, points_total: 60, real_name: 'Chetan Bk' })
  ];
  const dynamoMock = mockScan(rows, new Map([[6, [standingsRow('Chetan Bk')]]]));
  const fetchMock = mockActiveGwFetch(6);
  try {
    const result = await handleTrendsManagers({}, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(body.managers.length, 1);
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrends returns 400 when manager is missing', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrends({}, {});
    assert.strictEqual(result.statusCode, 400);
  } finally {
    mock.restore();
  }
});

test('handleTrends returns 404 for a manager with no rows', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrends({ manager: 'Nobody Here' }, {});
    assert.strictEqual(result.statusCode, 404);
  } finally {
    mock.restore();
  }
});

// Multi-league foundation (2026-08-14, rewired 2026-08-14 onto group_seasons):
// group-based season scoping.
test('a league_id with no group_seasons registration behaves exactly like today (no scoping)', async () => {
  // No groupSeasonRows given -- group_seasons has nothing for league_id 438107, e.g. a
  // league that's real but hasn't been seeded/onboarded into a group yet (registration
  // is a separate, manual, opt-in step -- see scripts/seed-default-group.mjs /
  // scripts/add-league.mjs).
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrends({ manager: 'Alice Smith', league_id: '438107' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    // Both the historical (2024/25) and current (2025/26) seasons are still present --
    // unregistered means unscoped, same as passing no league_id at all.
    assert.deepStrictEqual(body.seasons.map((s) => s.season), [SEASON_PAST, SEASON_CURRENT]);
  } finally {
    mock.restore();
  }
});

test('a league_id registered in group_seasons excludes seasons outside that group', async () => {
  // Alice's group ('carpe-diem') only has a group_seasons row for the CURRENT season --
  // the historical season (2024/25) belongs to a different, unrelated group in this
  // scenario (e.g. it could be a totally different friend group's data that happens to
  // share this shared fpl_entry_gameweek table once a second league's backfill exists --
  // see group-seasons.mjs's header comment for why that's the actual risk this protects
  // against). Once scoped, only the current season should survive the walk.
  const groupSeasonRows = [
    { group_id: 'carpe-diem', season_string: SEASON_CURRENT, league_id: 438107 }
    // Deliberately no row for SEASON_PAST under 'carpe-diem' -- it's outside the group.
  ];
  const mock = mockScan(buildFixtureRows(), new Map(), groupSeasonRows);
  try {
    const result = await handleTrends({ manager: 'Alice Smith', league_id: '438107' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(body.seasons.map((s) => s.season), [SEASON_CURRENT]);
    // The historical envelope (built from OTHER seasons besides current) should be
    // empty too, since its one source (2024/25) was scoped out.
    assert.deepStrictEqual(body.pace.history_envelope, []);
  } finally {
    mock.restore();
  }
});

// GH #49 -- roster-level scoping. allowedSeasons/group_seasons above only decide which
// SEASONS to include; these tests cover the layer on top that decides which MANAGERS
// within an allowed season actually belong to the requesting league -- the gap that let
// an unrelated league's managers blend into Finish/Gap-to-1st/the worm graph once a
// second league's real data shared the same fpl_entry_gameweek table.
function rosterStandingsRow({ managerId, leagueId, gw = 6 }) {
  return { season_event: `${SEASON_CURRENT}#${gw}`, manager_id: managerId, league_id: leagueId };
}

// Dave Outsider (entry_id 4) belongs to some OTHER league whose 2025/26 data happens to
// share the same fpl_entry_gameweek table -- he's outside Carpe Diem's roster even
// though his season (2025/26) is otherwise an allowed one.
function buildFixtureRowsWithOutsider() {
  const rows = buildFixtureRows();
  for (let gw = 1; gw <= 6; gw++) {
    rows.push(gwRow({ season: SEASON_CURRENT, entry_id: 4, gameweek: gw, points_total: gw * 100, real_name: 'Dave Outsider' }));
  }
  return rows;
}

test('roster-level scoping excludes a manager from an unrelated league sharing the same allowed season', async () => {
  const groupSeasonRows = [{ group_id: 'carpe-diem', season_string: SEASON_CURRENT, league_id: 438107 }];
  const rosterRows = [
    rosterStandingsRow({ managerId: 1, leagueId: 438107 }),
    rosterStandingsRow({ managerId: 3, leagueId: 438107 })
    // Deliberately no roster row for manager_id 4 (Dave) -- he's some other league.
  ];
  const mock = mockScan(buildFixtureRowsWithOutsider(), new Map(), groupSeasonRows, rosterRows, 'Carpe Diem');
  try {
    const result = await handleTrends({ manager: 'Alice Smith', league_id: '438107' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);

    // Dave out-scores everyone (100/gw) -- if he leaked into the field/ranking, he'd be
    // both the field leader and would push Alice off rank 1. He must not appear at all.
    assert.ok(!body.field.some((m) => m.real_name === 'Dave Outsider'), 'Dave should be excluded from the field entirely');
    assert.strictEqual(body.field.length, 2);

    const currentSeasonSummary = body.seasons.find((s) => s.season === SEASON_CURRENT);
    // Alice (60/gw) still outranks Carol (45/gw) once Dave's excluded.
    assert.strictEqual(currentSeasonSummary.final_rank, 1);
    assert.strictEqual(currentSeasonSummary.gap_to_first, 0);
    assert.strictEqual(currentSeasonSummary.league_id, 438107);

    assert.strictEqual(body.league_name, 'Carpe Diem');
  } finally {
    mock.restore();
  }
});

test('roster-level scoping is skipped (falls back to unscoped) when the league_id has no backfilled standings yet', async () => {
  // group_seasons resolves a league_id for the current season, but fpl_league_standings
  // has nothing stamped with it yet (e.g. registered but not yet backfilled) -- must NOT
  // silently exclude everyone, including the requesting manager themselves.
  const groupSeasonRows = [{ group_id: 'carpe-diem', season_string: SEASON_CURRENT, league_id: 438107 }];
  const mock = mockScan(buildFixtureRowsWithOutsider(), new Map(), groupSeasonRows, [], 'Carpe Diem');
  try {
    const result = await handleTrends({ manager: 'Alice Smith', league_id: '438107' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    // Unscoped -- Dave shows up exactly like before this fix.
    assert.ok(body.field.some((m) => m.real_name === 'Dave Outsider'));
    assert.strictEqual(body.field.length, 3);
  } finally {
    mock.restore();
  }
});

test('without a league_id, roster-level scoping never kicks in and league_name is null', async () => {
  const mock = mockScan(buildFixtureRowsWithOutsider());
  try {
    const result = await handleTrends({ manager: 'Alice Smith' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.league_name, null);
    assert.ok(body.field.some((m) => m.real_name === 'Dave Outsider'), 'Unscoped behavior unchanged when no league_id is passed at all');
    assert.strictEqual(body.seasons.find((s) => s.season === SEASON_CURRENT).league_id, null);
  } finally {
    mock.restore();
  }
});

test('handleTrends computes the historical envelope and the current-GW diff correctly', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrends({ manager: 'Alice Smith' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.current_season, SEASON_CURRENT);
    assert.strictEqual(body.current_gameweek, 6);

    // Only one historical season, so avg/min/max at any GW all equal that season's
    // own value there -- GW6 in 2024/25 was 6*50 = 300.
    const envAtGw6 = body.pace.history_envelope.find((e) => e.gameweek === 6);
    assert.strictEqual(envAtGw6.avg, 300);
    assert.strictEqual(envAtGw6.min, 300);
    assert.strictEqual(envAtGw6.max, 300);

    // This season at GW6: 6*60 = 360 -- 60 pts ahead of the 300 average.
    assert.strictEqual(body.pace.at_current_gw.this_season, 360);
    assert.strictEqual(body.pace.at_current_gw.avg, 300);
    assert.strictEqual(body.pace.at_current_gw.diff, 60);
  } finally {
    mock.restore();
  }
});

test('handleTrends ranks against peers, not just the requested manager\'s own data', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrends({ manager: 'Alice Smith' }, {});
    const body = JSON.parse(result.body);
    const pastSeason = body.seasons.find((s) => s.season === SEASON_PAST);

    // Alice out-scores Bob every gameweek in the fixture (50/gw vs 40/gw), so she's
    // rank 1 both at GW10 and at the season's final gameweek.
    assert.strictEqual(pastSeason.mid_rank, 1);
    assert.strictEqual(pastSeason.final_rank, 1);
    assert.strictEqual(pastSeason.final_points, 600);
    assert.strictEqual(pastSeason.is_current, false);

    const currentSeasonSummary = body.seasons.find((s) => s.season === SEASON_CURRENT);
    assert.strictEqual(currentSeasonSummary.is_current, true);
    // Only 6 gameweeks played so far -- no GW10 row yet, so mid_rank must be null
    // rather than a wrong guess.
    assert.strictEqual(currentSeasonSummary.mid_rank, null);
  } finally {
    mock.restore();
  }
});

test('handleTrends handles a manager with only historical data (no current-season row)', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrends({ manager: 'Bob Jones' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.current_gameweek, null);
    assert.strictEqual(body.pace.this_season.length, 0);
    assert.strictEqual(body.pace.at_current_gw, null);
    assert.strictEqual(body.seasons.length, 1);
    // The field always reflects who's actually in the current season (Alice and
    // Carol), regardless of who's asking -- Bob just won't be one of the entries, and
    // won't be flagged is_you on either of them.
    assert.strictEqual(body.field.length, 2);
    assert.ok(body.field.every((m) => m.is_you === false));
  } finally {
    mock.restore();
  }
});

test('handleTrends builds the "vs the field" worm-graph data for the current season', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrends({ manager: 'Alice Smith' }, {});
    const body = JSON.parse(result.body);

    // Alice (60/gw) and Carol (45/gw) both played the current season -- Bob never did,
    // so he must not show up as a third line.
    assert.strictEqual(body.field.length, 2);

    const alice = body.field.find((m) => m.real_name === 'Alice Smith');
    const carol = body.field.find((m) => m.real_name === 'Carol White');

    // Alice out-scores Carol every week, so she's actually the leader too -- but
    // is_leader is deliberately suppressed on your OWN entry (only is_you is set),
    // so the frontend never needs to draw two highlighted lines for the same person.
    assert.strictEqual(alice.is_you, true);
    assert.strictEqual(alice.is_leader, false);
    assert.strictEqual(carol.is_you, false);
    assert.strictEqual(carol.is_leader, false);

    // Full weekly series, not just the latest point.
    assert.strictEqual(alice.points.length, 6);
    assert.deepStrictEqual(alice.points[5], { gameweek: 6, points: 360 });
    assert.deepStrictEqual(carol.points[5], { gameweek: 6, points: 270 });
  } finally {
    mock.restore();
  }
});

test('handleTrends marks the field leader correctly when the requested manager is behind', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    // Carol (45/gw) is behind Alice (60/gw) this season -- Alice should be flagged as
    // leader on Carol's own response, and Carol should not be marked leader on her own.
    const result = await handleTrends({ manager: 'Carol White' }, {});
    const body = JSON.parse(result.body);

    const alice = body.field.find((m) => m.real_name === 'Alice Smith');
    const carol = body.field.find((m) => m.real_name === 'Carol White');

    assert.strictEqual(carol.is_you, true);
    assert.strictEqual(carol.is_leader, false);
    assert.strictEqual(alice.is_you, false);
    assert.strictEqual(alice.is_leader, true);
  } finally {
    mock.restore();
  }
});
