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
import { installFetchMock, jsonResponse } from './helpers/mock-fetch.mjs';
import { handleTrends, handleTrendsManagers } from '../handlers/trends.mjs';

const SEASON_PAST = '2024/25';
const SEASON_CURRENT = '2025/26';
const LEAGUE_ID = 999111;

// handleTrendsManagers sources the current roster from FPL's live league API, not
// from ingested gameweek data (which may not exist yet pre-season, and can't tell a
// real returner from someone who quietly dropped the league). `names` becomes
// `standings.results[].player_name` -- the same field getLeagueManagers() in the
// ingester reads once a league has an established (non-brand-new) history.
function mockLeagueFetch(names) {
  return installFetchMock((url) => {
    if (url.includes(`leagues-classic/${LEAGUE_ID}/standings`)) {
      return jsonResponse({
        standings: { results: names.map((n, i) => ({ entry: i + 1, entry_name: 'Team', player_name: n })) }
      });
    }
    return null;
  });
}

function gwRow({ season, entry_id, gameweek, points_total, team_name, manager_name = null }) {
  return {
    season_entry: `${season}#${entry_id}`,
    gameweek,
    entry_id,
    season,
    team_name,
    manager_name,
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
    rows.push(gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: gw, points_total: gw * 50, team_name: 'Alice Smith' }));
    rows.push(gwRow({ season: SEASON_PAST, entry_id: 2, gameweek: gw, points_total: gw * 40, team_name: 'Bob Jones' }));
  }
  for (let gw = 1; gw <= 6; gw++) {
    rows.push(gwRow({ season: SEASON_CURRENT, entry_id: 1, gameweek: gw, points_total: gw * 60, team_name: 'Alice Smith', manager_name: "Alice's Aces" }));
    rows.push(gwRow({ season: SEASON_CURRENT, entry_id: 3, gameweek: gw, points_total: gw * 45, team_name: 'Carol White', manager_name: "Carol's Crew" }));
  }
  return rows;
}

function mockScan(rows) {
  return installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'fpl_entry_gameweek') {
      return { Items: rows };
    }
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'seasons') {
      return { Items: [{ season_string: SEASON_CURRENT, season_id: 2, current: true, league_id: LEAGUE_ID }] };
    }
    return undefined;
  });
}

test('handleTrendsManagers dedupes by real name and fills in a nickname when one exists', async () => {
  const dynamoMock = mockScan(buildFixtureRows());
  const fetchMock = mockLeagueFetch(['Alice Smith', 'Carol White']);
  try {
    const result = await handleTrendsManagers({});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    // Alice and Carol are both on the live FPL roster this season; Bob only ever
    // played the past season and never rejoined, so he's excluded (see next test).
    assert.strictEqual(body.managers.length, 2);
    const alice = body.managers.find((m) => m.team_name === 'Alice Smith');
    assert.strictEqual(alice.manager_name, "Alice's Aces");
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrendsManagers excludes a manager not on the current live FPL roster', async () => {
  const dynamoMock = mockScan(buildFixtureRows());
  // Bob has current-season fpl_entry_gameweek rows in this fixture (unlike the past
  // version of this test), but the LIVE FPL roster below doesn't include him -- e.g.
  // he played last season but quietly didn't rejoin. The picker should trust the live
  // roster over ingested history, since ingested data can't see a drop-out at all.
  const fetchMock = mockLeagueFetch(['Alice Smith', 'Carol White']);
  try {
    const result = await handleTrendsManagers({});
    const body = JSON.parse(result.body);
    const bob = body.managers.find((m) => m.team_name === 'Bob Jones');
    assert.strictEqual(bob, undefined);
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrendsManagers falls back to the latest ingested season if the live FPL API fails', async () => {
  const dynamoMock = mockScan(buildFixtureRows());
  const fetchMock = installFetchMock(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    const result = await handleTrendsManagers({});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    // Fails open to whoever has a row in the most recent ingested season (2025/26:
    // Alice and Carol) rather than showing an empty picker.
    assert.strictEqual(body.managers.length, 2);
    assert.ok(body.managers.some((m) => m.team_name === 'Alice Smith'));
    assert.ok(body.managers.some((m) => m.team_name === 'Carol White'));
  } finally {
    dynamoMock.restore();
    fetchMock.restore();
  }
});

test('handleTrendsManagers collapses whitespace variants of the same name', async () => {
  const rows = [
    gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: 1, points_total: 50, team_name: 'Chetan Bk' }),
    gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: 2, points_total: 100, team_name: 'Chetan Bk' }),
    gwRow({ season: SEASON_CURRENT, entry_id: 1, gameweek: 1, points_total: 60, team_name: 'Chetan Bk' })
  ];
  const dynamoMock = mockScan(rows);
  const fetchMock = mockLeagueFetch(['Chetan Bk']);
  try {
    const result = await handleTrendsManagers({});
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

    const alice = body.field.find((m) => m.team_name === 'Alice Smith');
    const carol = body.field.find((m) => m.team_name === 'Carol White');

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

    const alice = body.field.find((m) => m.team_name === 'Alice Smith');
    const carol = body.field.find((m) => m.team_name === 'Carol White');

    assert.strictEqual(carol.is_you, true);
    assert.strictEqual(carol.is_leader, false);
    assert.strictEqual(alice.is_you, false);
    assert.strictEqual(alice.is_leader, true);
  } finally {
    mock.restore();
  }
});
