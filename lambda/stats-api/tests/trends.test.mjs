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
import { handleTrends, handleTrendsManagers } from '../handlers/trends.mjs';

const SEASON_PAST = '2024/25';
const SEASON_CURRENT = '2025/26';

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

// Two managers, one past season (full 12 GWs) and one current season (through GW6),
// so both the historical-envelope logic and the "at current GW" diff have something to
// chew on. Alice is ahead of her own history at the current GW; Bob has no live-season
// row at all (only ever played the historical season) to exercise that edge case.
function buildFixtureRows() {
  const rows = [];
  for (let gw = 1; gw <= 12; gw++) {
    rows.push(gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: gw, points_total: gw * 50, team_name: 'Alice Smith' }));
    rows.push(gwRow({ season: SEASON_PAST, entry_id: 2, gameweek: gw, points_total: gw * 40, team_name: 'Bob Jones' }));
  }
  for (let gw = 1; gw <= 6; gw++) {
    rows.push(gwRow({ season: SEASON_CURRENT, entry_id: 1, gameweek: gw, points_total: gw * 60, team_name: 'Alice Smith', manager_name: "Alice's Aces" }));
  }
  return rows;
}

function mockScan(rows) {
  return installDynamoMock((command) => {
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'fpl_entry_gameweek') {
      return { Items: rows };
    }
    if (command.constructor.name === 'ScanCommand' && command.input.TableName === 'seasons') {
      return { Items: [{ season_string: SEASON_CURRENT, season_id: 2, current: true }] };
    }
    return undefined;
  });
}

test('handleTrendsManagers dedupes by real name and fills in a nickname when one exists', async () => {
  const mock = mockScan(buildFixtureRows());
  try {
    const result = await handleTrendsManagers({});
    const body = JSON.parse(result.body);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.managers.length, 2);
    const alice = body.managers.find((m) => m.team_name === 'Alice Smith');
    assert.strictEqual(alice.manager_name, "Alice's Aces");
    const bob = body.managers.find((m) => m.team_name === 'Bob Jones');
    assert.strictEqual(bob.manager_name, null);
  } finally {
    mock.restore();
  }
});

test('handleTrendsManagers collapses whitespace variants of the same name', async () => {
  const rows = [
    gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: 1, points_total: 50, team_name: 'Chetan Bk' }),
    gwRow({ season: SEASON_PAST, entry_id: 1, gameweek: 2, points_total: 100, team_name: 'Chetan Bk' })
  ];
  const mock = mockScan(rows);
  try {
    const result = await handleTrendsManagers({});
    const body = JSON.parse(result.body);
    assert.strictEqual(body.managers.length, 1);
  } finally {
    mock.restore();
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
  } finally {
    mock.restore();
  }
});
