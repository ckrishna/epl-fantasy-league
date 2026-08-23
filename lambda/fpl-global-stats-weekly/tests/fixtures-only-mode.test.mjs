// EVAL: handler()'s new `event.mode === 'fixtures-only'` branch in index.mjs
//
// Context: fpl_fixture_data (kickoff_time for every fixture) was only ever refreshed
// by this Lambda's existing Tuesday-weekly EventBridge rule, alongside a much heavier
// per-player element-summary loop (~700 FPL API calls). A second, daily rule is being
// added so fixtures stay fresh enough for a same-day "is this a game day" check
// elsewhere in the app, without also re-running that expensive loop every day. The
// fix: a `mode: 'fixtures-only'` flag on the event skips storePlayerGameweekData
// entirely and only runs storeFixtures.
//
// This Lambda had NO test infrastructure at all before this file -- helpers copied
// verbatim from lambda/fpl-data-ingester/tests/helpers (both are fully generic, not
// tied to any one Lambda's specific tables/commands).
//
// These tests confirm: (1) fixtures-only mode never calls element-summary or writes
// player_event_stats, but does write fpl_fixture_data; (2) default/no-mode behavior is
// completely unchanged -- both run; (3) a real regression risk found while building
// this: EventBridge's custom Input JSON completely REPLACES the event, so the
// fixtures-only rule's Input must itself include `source: "aws.events"` or every one
// of its runs would misreport as `trigger: "manual"` in ingestion_runs. That risk is
// asserted here, not just described in a comment.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_TEAMS = [{ id: 1, name: 'Arsenal' }, { id: 2, name: 'Chelsea' }];
const SAMPLE_ELEMENT_TYPES = [{ id: 1, singular_name: 'Goalkeeper' }];
const SAMPLE_PLAYER = { id: 26, web_name: 'Salah', team: 1, element_type: 1, now_cost: 130, selected_by_percent: '45.2', form: '8.1' };
const SAMPLE_FIXTURE = {
  id: 1, event: 1, team_h: 1, team_a: 2, team_h_score: 2, team_a_score: 1,
  team_h_difficulty: 3, team_a_difficulty: 4, kickoff_time: '2026-08-23T14:00:00Z',
  finished: true, started: true, minutes: 90
};

function installWeeklyDynamoMock({ seasonId = 1 } = {}) {
  const writesByTable = { player_event_stats: [], fpl_fixture_data: [], ingestion_runs: [] };
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;

    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: seasonId, season_string: '2026/27', current: true }] };
    }
    if (name === 'PutCommand' && writesByTable[table]) {
      writesByTable[table].push(command.input.Item);
      return {};
    }
    return undefined;
  });
  return { ...dynamoMock, writesByTable };
}

test('fixtures-only mode never touches element-summary or player_event_stats, but does refresh fixtures', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: buildMidSeasonEvents(1, 38),
        elements: [SAMPLE_PLAYER],
        teams: SAMPLE_TEAMS,
        element_types: SAMPLE_ELEMENT_TYPES
      }));
    }
    if (url.includes('/fixtures/')) return jsonResponse([SAMPLE_FIXTURE]);
    // Deliberately no route for element-summary -- if fixtures-only mode is broken
    // and calls it anyway, installFetchMock throws immediately, failing this test loudly.
    return null;
  });
  const dynamoMock = installWeeklyDynamoMock();

  try {
    const result = await handler({ mode: 'fixtures-only', source: 'aws.events' });

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(dynamoMock.writesByTable.player_event_stats.length, 0, 'fixtures-only mode must not write any player_event_stats rows');
    assert.strictEqual(dynamoMock.writesByTable.fpl_fixture_data.length, 1, 'fixtures-only mode should still write fpl_fixture_data');
    assert.strictEqual(dynamoMock.writesByTable.fpl_fixture_data[0].kickoff_time, '2026-08-23T14:00:00Z');

    const runRow = dynamoMock.writesByTable.ingestion_runs[0];
    assert.strictEqual(runRow.summary.mode, 'fixtures-only');
    assert.strictEqual(runRow.trigger, 'scheduled', 'custom Input must preserve source:"aws.events" or this silently misreports as manual');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('default (no mode) behavior is unchanged -- both player stats and fixtures run', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: buildMidSeasonEvents(1, 38),
        elements: [SAMPLE_PLAYER],
        teams: SAMPLE_TEAMS,
        element_types: SAMPLE_ELEMENT_TYPES
      }));
    }
    if (url.includes('/fixtures/')) return jsonResponse([SAMPLE_FIXTURE]);
    if (url.includes('/element-summary/26/')) {
      return jsonResponse({ history: [{ round: 1, total_points: 9, minutes: 90, bonus: 3, bps: 42 }] });
    }
    return null;
  });
  const dynamoMock = installWeeklyDynamoMock();

  try {
    const result = await handler({ source: 'aws.events' });

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(dynamoMock.writesByTable.player_event_stats.length, 1, 'default mode should still write player_event_stats');
    assert.strictEqual(dynamoMock.writesByTable.player_event_stats[0].total_points, 9);
    assert.strictEqual(dynamoMock.writesByTable.fpl_fixture_data.length, 1);

    const runRow = dynamoMock.writesByTable.ingestion_runs[0];
    assert.strictEqual(runRow.summary.mode, 'full');
    assert.strictEqual(runRow.trigger, 'scheduled');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('a manual invoke (no source field at all) still records trigger:"manual", mode split aside', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [], teams: [], element_types: [] }));
    }
    if (url.includes('/fixtures/')) return jsonResponse([]);
    return null;
  });
  const dynamoMock = installWeeklyDynamoMock();

  try {
    await handler({ mode: 'fixtures-only' }); // no source field -- e.g. a manual CLI invoke with this same payload
    const runRow = dynamoMock.writesByTable.ingestion_runs[0];
    assert.strictEqual(runRow.trigger, 'manual');
    assert.strictEqual(runRow.summary.mode, 'fixtures-only');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
