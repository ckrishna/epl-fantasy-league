// EVAL: handler() writes an audit row to ingestion_runs on every invocation.
//
// Bug: this project had no way to see how the nightly sync (the `fpl-nightly-pull`
// EventBridge rule, confirmed live to run daily at 04:00 UTC against this function)
// was actually going -- no success/failure history, no duration tracking, nothing.
// DATA_MODEL.md has flagged this gap for a while ("no table currently tracks
// nightly/weekly ingestion run history"). Fixed by writing one row per invocation
// (success or failure) to a new ingestion_runs table, with `trigger` derived from the
// Lambda event shape -- EventBridge's own scheduled invocations always carry
// `source: "aws.events"`, which is also how fpl-bootstrap was discovered live to have
// no EventBridge rule at all (manual-only).
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

function installHappyPathMocks() {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(1, 38), elements: [] }));
    }
    if (url.includes('leagues-classic')) {
      return jsonResponse({
        league: { id: 438107, name: 'Carpe Diem' },
        standings: { has_next: false, page: 1, results: [] },
        new_entries: { has_next: false, page: 1, results: [] }
      });
    }
    return null;
  });

  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 2, season_string: '2026/27', current: true, league_id: 438107 }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') return { Items: [] };
    if (name === 'PutCommand') { puts.push({ table, item: command.input.Item }); return {}; }
    if (name === 'BatchWriteCommand') return {};
    return undefined;
  });

  return { fetchMock, dynamoMock: { ...dynamoMock, puts } };
}

test('[current bug] successful run writes an ingestion_runs row with status success', async () => {
  const { fetchMock, dynamoMock } = installHappyPathMocks();
  try {
    await handler({ source: 'aws.events' });

    const runs = dynamoMock.puts.filter((p) => p.table === 'ingestion_runs');
    assert.strictEqual(runs.length, 1, 'Expected exactly one ingestion_runs row written');
    const run = runs[0].item;
    assert.strictEqual(run.function_name, 'fpl-data-ingester');
    assert.strictEqual(run.status, 'success');
    assert.strictEqual(run.trigger, 'scheduled', 'Expected event.source === "aws.events" to be detected as a scheduled run');
    assert.strictEqual(run.season, '2026/27');
    assert.ok(typeof run.duration_ms === 'number' && run.duration_ms >= 0);
    assert.ok(run.started_at && run.finished_at);
    assert.strictEqual(run.error_message, null);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[current bug] a manual invocation (no aws.events source) is recorded as trigger: manual', async () => {
  const { fetchMock, dynamoMock } = installHappyPathMocks();
  try {
    await handler({});
    const run = dynamoMock.puts.find((p) => p.table === 'ingestion_runs').item;
    assert.strictEqual(run.trigger, 'manual');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[current bug] a failed run (no current season) still writes an ingestion_runs row, with status failure', async () => {
  const fetchMock = installFetchMock(() => null); // should never be reached
  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;
    if (table === 'seasons' && name === 'ScanCommand') return { Items: [] }; // no current season -> throws
    if (name === 'PutCommand') { puts.push({ table, item: command.input.Item }); return {}; }
    return undefined;
  });

  try {
    const result = await handler({ source: 'aws.events' });
    assert.strictEqual(result.statusCode, 500);

    const runs = puts.filter((p) => p.table === 'ingestion_runs');
    assert.strictEqual(runs.length, 1);
    const run = runs[0].item;
    assert.strictEqual(run.status, 'failure');
    assert.strictEqual(run.season, null, 'season was never resolved before the failure, so it should be null, not crash');
    assert.match(run.error_message, /No current season found/);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
