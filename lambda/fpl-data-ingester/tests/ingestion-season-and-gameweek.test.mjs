// EVAL: handler() in index.mjs (the nightly FPL data ingester)
//
// Two bugs here, both stemming from the same root cause as the stats-api bugs:
//
//  1. `activeGW = bootstrap.events.find(e => e.is_current)?.id || 26` -- once the
//     season ends (no event is ever "current" again), this permanently falls back to
//     a hardcoded 26, so the ingester would keep re-fetching only GW25/GW26 forever
//     and never progress, even though the real season continued through GW38.
//
//  2. `const SEASON = '2025/26'` is a hardcoded module-level constant, disconnected
//     from the `seasons` DynamoDB table that fpl-bootstrap/genbi/fpl-global-stats-weekly
//     already treat as the source of truth. Nothing will remind anyone to update this
//     literal when the 2026/27 season starts.
//
// This test drives the full handler() end-to-end with mocked fetch + DynamoDB and
// observes behavior only: which gameweeks were actually requested from the FPL picks
// endpoint, and what season string ends up in the stored records. Each test takes a
// couple of real seconds because the ingester intentionally rate-limits itself with a
// 1s sleep between picks calls -- that's expected, not a hang.
//
// Run BEFORE the fix: expect FAIL on the "current bug" test.
// Run AFTER the fix: expect all tests to PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 162357, entry_name: 'Da Movement', player_name: 'Michael Kojo Brown' };

function picksResponse() {
  return jsonResponse({
    entry_history: {
      points: 50,
      event_transfers_cost: 0,
      total_points: 1000,
      event_transfers: 1,
      transfers_left: 1,
      active_chip: null,
      bank: 5,
      value: 1000
    },
    picks: [] // keep storePicks() a no-op so BatchWriteCommand never needs mocking
  });
}

function installIngesterFetchMock(events) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events, elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/picks/')) return picksResponse();
    return null;
  });
}

function installIngesterDynamoMock({ currentSeason }) {
  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;

    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: currentSeason, current: true }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') {
      return { Items: [] }; // both the winners-calc scan and per-manager standings scan
    }
    if (name === 'PutCommand') {
      puts.push({ table, item: command.input.Item });
      return {};
    }
    if (name === 'BatchWriteCommand') {
      return {}; // shouldn't be hit since picks: [] above, but don't blow up if it is
    }
    return undefined;
  });
  return { ...dynamoMock, puts };
}

function gwsFetchedFrom(fetchMock) {
  return fetchMock.calls
    .filter((c) => c.url.includes('/picks/'))
    .map((c) => Number(c.url.match(/\/event\/(\d+)\/picks/)[1]))
    .sort((a, b) => a - b);
}

test('[current bug] post-season run fetches the true final gameweeks and stores the current season, not stale hardcoded values', async () => {
  const fetchMock = installIngesterFetchMock(buildPostSeasonEvents(38));
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2026/27' }); // simulates the season having rolled over

  try {
    await handler({});

    const gwsFetched = gwsFetchedFrom(fetchMock);
    assert.deepStrictEqual(gwsFetched, [37, 38], `Expected picks requests for GW37 and GW38 (the real final ` +
      `gameweeks), got [${gwsFetched.join(', ')}]. A hardcoded activeGW fallback of 26 would request ` +
      `[25, 26] here regardless of what the season actually looked like -- this is why the ingester can get ` +
      `permanently stuck once the FPL API stops marking any gameweek "is_current".`);

    const gwSummaryPut = dynamoMock.puts.find((p) => p.table === 'fpl_entry_gameweek');
    assert.ok(gwSummaryPut, 'Expected at least one write to fpl_entry_gameweek');
    assert.strictEqual(gwSummaryPut.item.season, '2026/27', `Expected the stored season to match the ` +
      `seasons table ("2026/27"), got "${gwSummaryPut.item.season}". This means SEASON is still a hardcoded ` +
      `module constant instead of being resolved from the shared seasons table.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] normal mid-season run still fetches only the current and previous gameweek', async () => {
  const fetchMock = installIngesterFetchMock(buildMidSeasonEvents(20, 38));
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});

    const gwsFetched = gwsFetchedFrom(fetchMock);
    assert.deepStrictEqual(gwsFetched, [19, 20]);

    const gwSummaryPut = dynamoMock.puts.find((p) => p.table === 'fpl_entry_gameweek');
    assert.strictEqual(gwSummaryPut.item.season, '2025/26');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
