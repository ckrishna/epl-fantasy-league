// EVAL: handler() in index.mjs -- rate-limit visibility on the per-manager picks fetch
//
// Before this fix, getManagerPicksForGW() collapsed EVERY non-ok response (a genuine
// 404 "no data yet", a 429 rate-limit, a 5xx server error) into a bare `null`, logged
// identically at INFO as "No data for GW N" -- indistinguishable from the normal,
// expected case of a manager who hasn't played that gameweek yet. Worse, the failure
// branch's `continue` ran BEFORE the 1s self-throttle pause, so the ingester actually
// sped up instead of backing off under real rate-limiting.
//
// These tests exercise the fixed behavior end-to-end via handler(): a still-429-after-
// retry is retried once, counted separately in ingestion_runs' summary as
// rate_limited_count, and paced with a longer backoff than the happy-path pause. An
// unexpected non-ok status (5xx) is tracked separately too (unexpected_status_count),
// without a retry. A genuine 404 is unchanged -- still ordinary, un-alarming "no data".
//
// Each of these takes several real seconds (the retry/backoff delays are real
// setTimeout calls, same intentional-delay pattern already used by
// ingestion-season-and-gameweek.test.mjs) -- that's expected, not a hang.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildMidSeasonEvents, buildBootstrapStatic } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 162357, entry_name: 'Da Movement', player_name: 'Michael Kojo Brown' };

function picksResponse() {
  return jsonResponse({
    active_chip: null,
    entry_history: {
      points: 50, event_transfers_cost: 0, total_points: 1000,
      event_transfers: 1, transfers_left: 1, bank: 5, value: 1000
    },
    picks: []
  });
}

function errorResponse(status) {
  return { ok: false, status, json: async () => ({}) };
}

// Only ever asks for a single gameweek (buildMidSeasonEvents(1, ...)), to keep the
// real-time cost of each retry/backoff delay to a minimum.
function installSingleGwFetchMock(picksRouter) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 5), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/') && url.includes('/live/')) return jsonResponse({ elements: [] });
    if (url.includes('/picks/')) return picksRouter(url);
    return null;
  });
}

function installMultiManagerFetchMock(managers, picksRouter) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 5), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: managers } });
    if (url.includes('/event/') && url.includes('/live/')) return jsonResponse({ elements: [] });
    if (url.includes('/picks/')) return picksRouter(url);
    return null;
  });
}

function installIngesterDynamoMock() {
  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true, league_id: 438107 }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') return { Items: [] };
    if (name === 'PutCommand') { puts.push({ table, item: command.input.Item }); return {}; }
    if (name === 'BatchWriteCommand') return {};
    return undefined;
  });
  return { ...dynamoMock, puts };
}

function picksCallCount(fetchMock) {
  return fetchMock.calls.filter((c) => c.url.includes('/picks/')).length;
}

test('a picks fetch still rate-limited after one retry is counted separately, retried exactly once, and paced with a longer backoff (not sped up)', async () => {
  const fetchMock = installSingleGwFetchMock(() => errorResponse(429)); // always 429
  const dynamoMock = installIngesterDynamoMock();

  const start = Date.now();
  try {
    await handler({});
    const elapsed = Date.now() - start;

    assert.strictEqual(picksCallCount(fetchMock), 2, 'Expected exactly one retry (2 total fetches: original + 1 retry)');

    const runPut = dynamoMock.puts.find((p) => p.table === 'ingestion_runs');
    assert.ok(runPut, 'Expected an ingestion_runs row to be written');
    assert.strictEqual(runPut.item.summary.rate_limited_count, 1, 'Expected the still-failing 429 to be counted in rate_limited_count');
    assert.strictEqual(runPut.item.summary.unexpected_status_count, 0, 'A 429 is its own category, not unexpected_status');

    // The whole point of this fix: ingestion_runs alone should say WHICH manager and
    // WHICH gameweek, not just that a 429 happened somewhere in the run.
    const events = runPut.item.summary.rate_limited_events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].entry_id, SAMPLE_MANAGER.entry);
    assert.strictEqual(events[0].manager, SAMPLE_MANAGER.entry_name);
    assert.strictEqual(events[0].gw, 1);
    assert.ok(events[0].timestamp && !Number.isNaN(Date.parse(events[0].timestamp)), 'Expected a real ISO timestamp on the event');
    assert.deepStrictEqual(runPut.item.summary.unexpected_status_events, []);

    // Retry backoff (5s) + post-failure backoff (5s) = 10s minimum. Allow slack for
    // test overhead, but this is the actual regression check for the throttle-skip
    // bug: before the fix, this path skipped the pause entirely (continue ran first).
    assert.ok(elapsed >= 9000, `Expected the rate-limited path to pace itself with at least ~10s of real delay (retry backoff + post-failure backoff), got ${elapsed}ms -- a fast completion here means the self-throttle is being skipped again.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('a 429 that succeeds on retry stores the picks normally, proving recovery not just detection', async () => {
  let calls = 0;
  const fetchMock = installSingleGwFetchMock(() => {
    calls += 1;
    return calls === 1 ? errorResponse(429) : picksResponse();
  });
  const dynamoMock = installIngesterDynamoMock();

  try {
    await handler({});

    assert.strictEqual(picksCallCount(fetchMock), 2, 'Expected the initial 429 plus one successful retry');

    const gwSummaryPut = dynamoMock.puts.find((p) => p.table === 'fpl_entry_gameweek');
    assert.ok(gwSummaryPut, 'Expected the retried fetch to succeed and store gameweek data, not be dropped');

    const runPut = dynamoMock.puts.find((p) => p.table === 'ingestion_runs');
    assert.strictEqual(runPut.item.summary.rate_limited_count, 0, 'A 429 that recovered on retry should not count as a still-rate-limited failure');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('an unexpected non-ok status (5xx) is tracked separately from both rate-limiting and normal no-data, without a retry', async () => {
  const fetchMock = installSingleGwFetchMock(() => errorResponse(500));
  const dynamoMock = installIngesterDynamoMock();

  try {
    await handler({});

    assert.strictEqual(picksCallCount(fetchMock), 1, 'A 5xx should not trigger the 429-only retry');

    const runPut = dynamoMock.puts.find((p) => p.table === 'ingestion_runs');
    assert.strictEqual(runPut.item.summary.unexpected_status_count, 1);
    assert.strictEqual(runPut.item.summary.rate_limited_count, 0);

    const events = runPut.item.summary.unexpected_status_events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 500, 'The event should carry the actual status code, not just that something unexpected happened');
    assert.strictEqual(events[0].entry_id, SAMPLE_MANAGER.entry);
    assert.strictEqual(events[0].gw, 1);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] a genuine 404 (manager has no data for this gameweek yet) is still ordinary, un-alarming no-data', async () => {
  const fetchMock = installSingleGwFetchMock(() => errorResponse(404));
  const dynamoMock = installIngesterDynamoMock();

  try {
    const response = await handler({});
    assert.strictEqual(JSON.parse(response.body).success, true, 'A routine 404 should not fail the whole run');

    assert.strictEqual(picksCallCount(fetchMock), 1, 'A 404 should not be retried');

    const runPut = dynamoMock.puts.find((p) => p.table === 'ingestion_runs');
    assert.strictEqual(runPut.item.summary.rate_limited_count, 0);
    assert.strictEqual(runPut.item.summary.unexpected_status_count, 0, 'A 404 is the normal case, not "unexpected"');

    const gwSummaryPut = dynamoMock.puts.find((p) => p.table === 'fpl_entry_gameweek');
    assert.strictEqual(gwSummaryPut, undefined, 'No picks data should be stored for a manager with no data that gameweek');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

// Uses the 5xx (no-retry) path rather than 429 specifically so this doesn't need 25+
// real managers each paying the 429 retry/backoff delay to exercise the cap -- an
// unexpected-status event costs only the normal 1s throttle pause per manager.
test('the event sample list is capped, but the count keeps counting past the cap (catches the earlier .overflow-on-array bug)', async () => {
  process.env.MAX_STORED_FAILURE_EVENTS = '2';
  const managers = Array.from({ length: 4 }, (_, i) => ({
    entry: 1000 + i, entry_name: `Team ${i}`, player_name: `Manager ${i}`
  }));
  const fetchMock = installMultiManagerFetchMock(managers, () => errorResponse(503));
  const dynamoMock = installIngesterDynamoMock();

  try {
    await handler({});

    const runPut = dynamoMock.puts.find((p) => p.table === 'ingestion_runs');
    assert.strictEqual(runPut.item.summary.unexpected_status_count, 4, 'The count must stay accurate for all 4 managers even though only 2 get stored as samples');
    assert.strictEqual(runPut.item.summary.unexpected_status_events.length, 2, 'The stored sample list should be capped at MAX_STORED_FAILURE_EVENTS');
    // Confirms the array itself round-trips cleanly through the same PutCommand.Item
    // shape DynamoDB marshaling would see -- no property hanging off the array outside
    // its indices, which is exactly what silently vanished in the first attempt.
    assert.deepStrictEqual(Object.keys(runPut.item.summary.unexpected_status_events), ['0', '1']);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    delete process.env.MAX_STORED_FAILURE_EVENTS;
  }
});
