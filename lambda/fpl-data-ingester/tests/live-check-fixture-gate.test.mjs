// EVAL: getTodaysFixtureWindow() / the `event.mode === 'live-check'` gate in index.mjs
//
// Context: a new hourly EventBridge rule (distinct from the existing unconditional
// nightly one) invokes this Lambda with `{mode: 'live-check', source: 'aws.events'}`.
// The gate must decide, using ONLY our own already-ingested fpl_fixture_data (a local
// DynamoDB Scan -- zero FPL API calls), whether right now falls inside today's live
// window: [earliest kickoff today + 30min, latest kickoff today + 4h]. Outside that
// window (or no fixtures today at all), the run should bail out before ever calling
// FPL's API -- confirmed here by deliberately NOT mocking bootstrap-static in the
// skip-path tests, so if the gate is broken and calls it anyway, installFetchMock's
// "no mock route matched" throw fails the test loudly.
//
// Also confirms: (1) the gate is opt-in -- a normal event with no mode always runs in
// full regardless of fixture timing, so the existing nightly rule is unaffected; (2)
// it fails OPEN on a DynamoDB error, not silently skipping a possibly-real game day;
// (3) trigger is still recorded correctly as "scheduled" on the skip path too.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 728477, entry_name: 'COYS', player_name: 'Chetan Bk' };

function fixtureItem(id, kickoffTime, seasonId = 1) {
  return { season_fixture: `${seasonId}#${id}`, event: 1, fixture_id: id, season_id: seasonId, kickoff_time: kickoffTime };
}

function installGateDynamoMock({ fixtures = [], fixtureScanThrows = false, seasonId = 1 } = {}) {
  const runWrites = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;

    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: seasonId, season_string: '2026/27', current: true, league_id: 438107 }] };
    }
    if (table === 'fpl_fixture_data' && name === 'ScanCommand') {
      if (fixtureScanThrows) throw new Error('simulated DynamoDB outage');
      return { Items: fixtures };
    }
    if (table === 'leagues' && name === 'ScanCommand') return { Items: [] };
    if (table === 'ingestion_runs' && name === 'PutCommand') {
      runWrites.push(command.input.Item);
      return {};
    }
    if (name === 'PutCommand') return {};
    if (name === 'BatchWriteCommand') return {};
    if (name === 'ScanCommand') return { Items: [] };
    return undefined;
  });
  return { ...dynamoMock, runWrites };
}

// No FPL mocks configured on purpose -- proves the gate never reaches getBootstrapStatic.
function installNoFplCallsFetchMock() {
  return installFetchMock(() => null);
}

test('live-check skips before any FPL call when there are no fixtures today', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dynamoMock = installGateDynamoMock({ fixtures: [fixtureItem(1, yesterday)] });
  const fetchMock = installNoFplCallsFetchMock();

  try {
    const result = await handler({ mode: 'live-check', source: 'aws.events' });
    const body = JSON.parse(result.body);
    assert.strictEqual(body.skipped, true);
    assert.strictEqual(body.reason, 'no_fixtures_today');
    assert.strictEqual(dynamoMock.runWrites[0].trigger, 'scheduled');
    assert.strictEqual(dynamoMock.runWrites[0].summary.reason, 'no_fixtures_today');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('live-check skips before any FPL call when today\'s only kickoff is still 10 minutes away', async () => {
  const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const dynamoMock = installGateDynamoMock({ fixtures: [fixtureItem(1, soon)] });
  const fetchMock = installNoFplCallsFetchMock();

  try {
    const result = await handler({ mode: 'live-check', source: 'aws.events' });
    const body = JSON.parse(result.body);
    assert.strictEqual(body.skipped, true);
    assert.strictEqual(body.reason, 'outside_fixture_window', 'a kickoff 10 min away is before the +30min window start');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('live-check skips before any FPL call when today\'s only match kicked off 5 hours ago', async () => {
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const dynamoMock = installGateDynamoMock({ fixtures: [fixtureItem(1, fiveHoursAgo)] });
  const fetchMock = installNoFplCallsFetchMock();

  try {
    const result = await handler({ mode: 'live-check', source: 'aws.events' });
    const body = JSON.parse(result.body);
    assert.strictEqual(body.skipped, true);
    assert.strictEqual(body.reason, 'outside_fixture_window', 'a kickoff 5h ago is past the +4h window end');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('live-check proceeds with a normal full run when now falls inside today\'s fixture window', async () => {
  const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const dynamoMock = installGateDynamoMock({ fixtures: [fixtureItem(1, fortyFiveMinAgo)] });
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/1/live/')) return jsonResponse({ elements: [] });
    if (url.includes('/picks/')) return jsonResponse(null, { ok: false, status: 404 });
    return null;
  });

  try {
    const result = await handler({ mode: 'live-check', source: 'aws.events' });
    const body = JSON.parse(result.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.skipped, undefined, 'a real run inside the window should not report skipped');
    assert.strictEqual(dynamoMock.runWrites[0].summary.mode, 'live-check');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('a plain nightly event (no mode) always runs in full, regardless of fixture timing', async () => {
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const dynamoMock = installGateDynamoMock({ fixtures: [fixtureItem(1, fiveHoursAgo)] });
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/1/live/')) return jsonResponse({ elements: [] });
    if (url.includes('/picks/')) return jsonResponse(null, { ok: false, status: 404 });
    return null;
  });

  try {
    const result = await handler({ source: 'aws.events' });
    const body = JSON.parse(result.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.skipped, undefined, 'the unconditional nightly rule must be unaffected by the gate entirely');
    assert.strictEqual(dynamoMock.runWrites[0].summary.mode, 'full');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('live-check fails open (runs normally) rather than silently skipping if the fixture scan errors', async () => {
  const dynamoMock = installGateDynamoMock({ fixtureScanThrows: true });
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/1/live/')) return jsonResponse({ elements: [] });
    if (url.includes('/picks/')) return jsonResponse(null, { ok: false, status: 404 });
    return null;
  });

  try {
    const result = await handler({ mode: 'live-check', source: 'aws.events' });
    const body = JSON.parse(result.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.skipped, undefined, 'a scan failure must fail OPEN -- a real full run, not a silent skip');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
