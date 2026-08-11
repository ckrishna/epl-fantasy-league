// EVAL: storeGameweekSummary()'s `active_chip` field in index.mjs
//
// Bug: `active_chip: entryHistory.active_chip || null` read active_chip from
// picksData.entry_history, but FPL's real /entry/{id}/event/{gw}/picks/ response has
// active_chip at the TOP LEVEL of the response, not nested inside entry_history.
// entryHistory.active_chip was therefore always undefined, silently masked by `|| null`.
//
// Found via the #55 silent-fallback audit (started after the fpl_entry_picks.points
// bug), then confirmed against live data: a DynamoDB scan of all 396
// fpl_entry_gameweek rows for `active_chip <> null` returned zero matches -- not
// plausible across 11 managers and up to 38 gameweeks each, since wildcard/bench-boost/
// triple-captain/free-hit are near-universally used at least once per season. This
// silently zeroed out #39 Phase 1's chips_used for every manager, every gameweek, since
// that feature shipped.
//
// Run BEFORE the fix: expect FAIL on the "current bug" test.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 162357, entry_name: 'Da Movement', player_name: 'Michael Kojo Brown' };

function picksResponse({ activeChip = null } = {}) {
  return jsonResponse({
    active_chip: activeChip,
    entry_history: {
      points: 50,
      event_transfers_cost: 0,
      total_points: 1000,
      event_transfers: 1,
      transfers_left: 1,
      bank: 5,
      value: 1000
    },
    picks: []
  });
}

function installIngesterDynamoMock({ currentSeason }) {
  const puts = [];
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const name = command.constructor.name;

    if (table === 'seasons' && name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: currentSeason, current: true, league_id: 438107 }] };
    }
    if (table === 'fpl_entry_gameweek' && name === 'ScanCommand') {
      return { Items: [] };
    }
    if (name === 'PutCommand') {
      puts.push({ table, item: command.input.Item });
      return {};
    }
    if (name === 'BatchWriteCommand') {
      return {};
    }
    return undefined;
  });
  return { ...dynamoMock, puts };
}

test('[current bug] a chip played this gameweek is stored, not silently dropped to null', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/picks/')) return picksResponse({ activeChip: 'wildcard' });
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    const gwSummaryPuts = dynamoMock.puts.filter((p) => p.table === 'fpl_entry_gameweek');
    assert.ok(gwSummaryPuts.length > 0, 'Expected at least one fpl_entry_gameweek write');
    for (const p of gwSummaryPuts) {
      assert.strictEqual(p.item.active_chip, 'wildcard', 'Expected the top-level active_chip to be stored, not read from the nonexistent entry_history.active_chip');
    }
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('[regression] no chip played still stores null, not "undefined" or a crash', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/picks/')) return picksResponse({ activeChip: null });
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    const gwSummaryPuts = dynamoMock.puts.filter((p) => p.table === 'fpl_entry_gameweek');
    assert.ok(gwSummaryPuts.length > 0);
    for (const p of gwSummaryPuts) {
      assert.strictEqual(p.item.active_chip, null);
    }
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
