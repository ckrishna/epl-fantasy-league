// EVAL: storeLiveGameweekPlayerStats() / getLiveGameweekStats() in index.mjs
//
// Context (GH issue #24, "[Phase 2] Populate live_player_event_stats during active
// gameweeks"): the ingester already fetches FPL's `/event/{gw}/live/` endpoint every
// run to compute manager points, but historically threw away everything except
// `total_points` -- minutes, goals, assists, bonus, bps, ICT components, expected-
// stats, all discarded. This is the fix: the same response now also gets persisted in
// full to a new `live_player_event_stats` table, as a side effect of the fetch that
// was already happening (no new API call).
//
// These tests confirm: (1) the full field set actually lands in DynamoDB, correctly
// joined against bootstrap identity data; (2) the row is keyed by season_id (numeric),
// not season_string -- this codebase has hit that exact mixup before (see
// getCurrentSeasonInfo's comment) so it's worth a standing regression test; (3) a
// player missing from the bootstrap player map (edge case, shouldn't normally happen)
// fails open with 'Unknown' rather than crashing the whole run.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 728477, entry_name: 'COYS', player_name: 'Chetan Bk' };

function richLiveElement(id, statsOverrides = {}, { modified = false } = {}) {
  return {
    id,
    stats: {
      minutes: 90,
      goals_scored: 1,
      assists: 0,
      clean_sheets: 1,
      goals_conceded: 0,
      own_goals: 0,
      penalties_saved: 0,
      penalties_missed: 0,
      yellow_cards: 0,
      red_cards: 0,
      saves: 0,
      bonus: 3,
      bps: 42,
      influence: '55.4',
      creativity: '12.1',
      threat: '38.0',
      ict_index: '10.5',
      clearances_blocks_interceptions: 2,
      recoveries: 4,
      tackles: 1,
      defensive_contribution: 3,
      starts: 1,
      expected_goals: '0.75',
      expected_assists: '0.10',
      expected_goal_involvements: '0.85',
      expected_goals_conceded: '0.20',
      total_points: 9,
      in_dreamteam: true,
      played: true,
      ...statsOverrides
    },
    modified
  };
}

function installLiveStatsDynamoMock({ currentSeason, seasonId = 1 }) {
  const liveStatsWrites = [];
  const dynamoMock = installDynamoMock((command) => {
    const name = command.constructor.name;

    if (command.input.TableName === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: seasonId, season_string: currentSeason, current: true, league_id: 438107 }] };
    }
    if (command.input.TableName === 'leagues' && name === 'ScanCommand') {
      return { Items: [] };
    }
    if (name === 'BatchWriteCommand' && command.input.RequestItems?.live_player_event_stats) {
      liveStatsWrites.push(...command.input.RequestItems.live_player_event_stats.map((r) => r.PutRequest.Item));
      return {};
    }
    if (name === 'BatchWriteCommand') {
      return {};
    }
    if (name === 'PutCommand') {
      return {};
    }
    if (name === 'ScanCommand') {
      return { Items: [] };
    }
    return undefined;
  });
  return { ...dynamoMock, liveStatsWrites };
}

test('captures the full per-player live detail (bonus, bps, ICT, expected-stats), not just total_points', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: buildMidSeasonEvents(1, 38),
        elements: [{ id: 26, web_name: 'Salah', team: 14, element_type: 4, now_cost: 130, selected_by_percent: '45.2', form: '8.1' }],
        teams: [{ id: 14, name: 'Liverpool' }],
        element_types: [{ id: 4, singular_name: 'Forward' }]
      }));
    }
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/1/live/')) return jsonResponse({ elements: [richLiveElement(26, {}, { modified: true })] });
    if (url.includes('/picks/')) return jsonResponse(null, { ok: false, status: 404 });
    return null;
  });
  const dynamoMock = installLiveStatsDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});

    const row = dynamoMock.liveStatsWrites.find((w) => w.player_id === 26);
    assert.ok(row, 'expected a live_player_event_stats row for player 26');

    assert.strictEqual(row.gameweek_player, '1#26');
    assert.strictEqual(row.name, 'Salah');
    assert.strictEqual(row.team_name, 'Liverpool');
    assert.strictEqual(row.position, 'Forward');
    assert.strictEqual(row.total_points, 9);
    assert.strictEqual(row.minutes, 90);
    assert.strictEqual(row.goals_scored, 1);
    assert.strictEqual(row.bonus, 3);
    assert.strictEqual(row.bps, 42);
    assert.strictEqual(row.ict_index, '10.5');
    assert.strictEqual(row.expected_goals, '0.75');
    assert.strictEqual(row.expected_assists, '0.10');
    assert.strictEqual(row.in_dreamteam, true);
    assert.strictEqual(row.played, true);
    assert.strictEqual(row.bonus_finalized, true, 'modified:true on the live response should map to bonus_finalized');
    assert.strictEqual(row.selected_by_percent, '45.2');
    assert.strictEqual(row.form, '8.1');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('keys rows by season_id (numeric), not season_string -- same mixup this codebase has hit before', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: buildMidSeasonEvents(1, 38),
        elements: [{ id: 26, web_name: 'Salah', team: 14, element_type: 4 }],
        teams: [{ id: 14, name: 'Liverpool' }],
        element_types: [{ id: 4, singular_name: 'Forward' }]
      }));
    }
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/1/live/')) return jsonResponse({ elements: [richLiveElement(26)] });
    if (url.includes('/picks/')) return jsonResponse(null, { ok: false, status: 404 });
    return null;
  });
  // A season_id that's numeric and deliberately different-looking from the season
  // string, so a bug that swapped the two would be obvious in the assertion below.
  const dynamoMock = installLiveStatsDynamoMock({ currentSeason: '2025/26', seasonId: 7 });

  try {
    await handler({});
    const row = dynamoMock.liveStatsWrites.find((w) => w.player_id === 26);
    assert.ok(row, 'expected a live_player_event_stats row for player 26');
    assert.strictEqual(row.season_id, 7, 'must be the numeric season_id, not the "2025/26" season_string');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('a player missing from the bootstrap player map fails open with "Unknown" instead of crashing the run', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      // No element for id 999 -- simulates the live endpoint returning a player id
      // bootstrap-static's own elements list doesn't (currently) have.
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [], teams: [], element_types: [] }));
    }
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/1/live/')) return jsonResponse({ elements: [richLiveElement(999)] });
    if (url.includes('/picks/')) return jsonResponse(null, { ok: false, status: 404 });
    return null;
  });
  const dynamoMock = installLiveStatsDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    const row = dynamoMock.liveStatsWrites.find((w) => w.player_id === 999);
    assert.ok(row, 'expected a row even for a player missing from the bootstrap map');
    assert.strictEqual(row.name, 'Unknown');
    assert.strictEqual(row.team_name, '');
    assert.strictEqual(row.position, '');
    // The live stats themselves should still be captured correctly even without an
    // identity match -- only the bootstrap-joined fields fall back.
    assert.strictEqual(row.total_points, 9);
    assert.strictEqual(row.bonus, 3);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
