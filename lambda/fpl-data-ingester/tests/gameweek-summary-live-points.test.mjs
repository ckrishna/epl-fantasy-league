// EVAL: storeGameweekSummary()'s points_this_week/points_gross/points_total in index.mjs
//
// Bug: these fields were read straight from FPL's `/entry/{id}/event/{gw}/picks/`
// response's `entry_history.points`/`entry_history.total_points`. Confirmed live on
// 2026-08-21 (GW1 kickoff): entry_history.points sat at 0 for over 40 minutes into a
// match in which the entry's captain had already scored and picked up bonus points,
// while the separate per-player `/event/{gw}/live/` endpoint (the one storePicks
// already joins against for fpl_entry_picks.points, and the one Manager Squad's
// handleManagerSquad already sums for team_gw_points_gross) reflected the goal within
// a couple of minutes. Anything sourced from entry_history alone -- fpl_league_standings
// and gw-winners-cache are both downstream of this function's output -- showed 0 for an
// entire live gameweek even as Manager Squad already showed the real score, because it
// reads a different, faster-updating source.
//
// Fix: storeGameweekSummary now takes the same livePoints map already computed for
// storePicks, and derives points_this_week by summing each STARTER's live points
// (bench excluded), doubled for the captain -- identical logic to
// handleManagerSquad's team_gw_points_gross, so Standings/GW-Winners agree with
// Manager Squad in real time instead of only after FPL finishes its own rollup.
// points_total is patched the same way: FPL's stale current-week contribution is
// swapped out for the live-computed one, leaving prior (already-settled) weeks alone.
//
// Run BEFORE the fix: expect FAIL on tests marked "current bug".
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 728477, entry_name: 'COYS', player_name: 'Chetan Bk' };

function picksResponse(picks, entryHistoryOverrides = {}) {
  return jsonResponse({
    active_chip: null,
    entry_history: {
      // Mirrors the real GW1 incident: FPL's own rollup hasn't moved yet.
      points: 0,
      total_points: 0,
      event_transfers_cost: 0,
      event_transfers: 0,
      transfers_left: 1,
      bank: 0,
      value: 1000,
      ...entryHistoryOverrides
    },
    picks
  });
}

function liveStatsResponse(elementPoints) {
  return jsonResponse({
    elements: Object.entries(elementPoints).map(([id, total_points]) => ({
      id: Number(id),
      stats: { total_points }
    }))
  });
}

function installIngesterDynamoMock({ currentSeason }) {
  const gameweekWrites = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;

    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: currentSeason, current: true, league_id: 438107 }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') {
      return { Items: [] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'PutCommand') {
      gameweekWrites.push(command.input.Item);
      return {};
    }
    if (name === 'PutCommand') {
      return {};
    }
    if (name === 'BatchWriteCommand') {
      return {};
    }
    return undefined;
  });
  return { ...dynamoMock, gameweekWrites };
}

test('[current bug] points_this_week comes from live per-player stats, not the still-zero entry_history.points', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    // Captain (element 26) has already scored live; a starter (418) hasn't played yet;
    // a benched player (529, position > 11) has a live score that must NOT count.
    if (url.includes('/event/1/live/')) return liveStatsResponse({ 26: 8, 418: 0, 529: 6 });
    if (url.includes('/picks/')) {
      return picksResponse([
        { element: 26, position: 9, multiplier: 2, is_captain: true, is_vice_captain: false },
        { element: 418, position: 2, multiplier: 1, is_captain: false, is_vice_captain: false },
        { element: 529, position: 12, multiplier: 0, is_captain: false, is_vice_captain: false } // bench
      ]);
    }
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});

    const gw1Write = dynamoMock.gameweekWrites.find((w) => w.gameweek === 1);
    assert.ok(gw1Write, 'expected a fpl_entry_gameweek row for GW1');

    // Captain's 8 live points doubled (16) + starter's 0 (hasn't played) = 16.
    // Bench player's 6 must be excluded even though they have live points.
    assert.strictEqual(gw1Write.points_this_week, 16, 'expected live-computed points, not entry_history.points (0)');
    assert.strictEqual(gw1Write.points_gross, 16);
    assert.strictEqual(gw1Write.points_total, 16, 'season total should reflect the same live-computed current-week points');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('a settled prior-week total is preserved when this week is still live', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/1/live/')) return liveStatsResponse({ 26: 8 });
    if (url.includes('/picks/')) {
      // FPL's entry_history still shows last week's settled total (60) plus this
      // week's stale (0) contribution -- i.e. total_points hasn't incorporated the
      // current live gameweek yet, same shape as the real incident.
      return picksResponse(
        [{ element: 26, position: 9, multiplier: 2, is_captain: true, is_vice_captain: false }],
        { points: 0, total_points: 60 }
      );
    }
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    const gw1Write = dynamoMock.gameweekWrites.find((w) => w.gameweek === 1);
    // (60 - 0) + 16 live-computed this week = 76
    assert.strictEqual(gw1Write.points_total, 76);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
