// EVAL: storePicks()'s DynamoDB sort key in index.mjs
//
// Bug: `fpl_entry_picks`' sort key was `position_player: `${pick.position}#${pick.element}``.
// `gwsToFetch` re-polls the SAME already-stored gameweek on every scheduled run
// (activeGW - 1 through activeGW, so post-autosub scores settle in over time -- see
// gwsToFetch). FPL's own auto-substitution processing (or a manager reordering their
// bench before a gameweek locks) can change a player's `pick.position` between two of
// those polls. Because PutCommand only overwrites an item when BOTH the partition key
// AND the sort key match exactly, a changed `position` meant a changed sort key, so the
// OLD row was never found/overwritten -- it was left behind as an orphaned duplicate
// alongside the new one. Caught live 2026-08-24: a manager's squad view showed several
// players twice, once as a starter and once on the bench.
//
// Fix: position_player is now `String(pick.element)` -- stable per player regardless of
// how many times `position` legitimately changes for the same (season, entry, gw,
// player). See scripts/dedupe-picks.mjs for cleaning up rows already duplicated by the
// old key before this fix shipped.
//
// This test can't exercise real DynamoDB overwrite semantics (the mock doesn't model
// per-key upserts), so it instead proves the fix at the level that actually matters: for
// the SAME player, across two separate ingestion runs of the SAME gameweek where FPL
// reports a DIFFERENT `position`, the sort key written must be IDENTICAL both times --
// which is exactly the property a real PutCommand needs to overwrite instead of
// duplicate.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildMidSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handler } from '../index.mjs';

const SAMPLE_MANAGER = { entry: 162357, entry_name: 'Da Movement', player_name: 'Michael Kojo Brown' };

function picksResponse(picks) {
  return jsonResponse({
    active_chip: null,
    entry_history: {
      points: 50,
      event_transfers_cost: 0,
      total_points: 1000,
      event_transfers: 1,
      transfers_left: 1,
      bank: 5,
      value: 1000
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
  const batchWrites = [];
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
      return {};
    }
    if (name === 'BatchWriteCommand') {
      batchWrites.push(...(command.input.RequestItems.fpl_entry_picks || []));
      return {};
    }
    return undefined;
  });
  return { ...dynamoMock, batchWrites };
}

test('[fixed] position_player sort key is stable for the same player even when FPL reports a different position on a later poll of the same gameweek', async () => {
  // Run 1: element 501 is a bench player (position 12) at the time of this poll.
  const fetchMock1 = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/20/live/')) return liveStatsResponse({ 501: 6 });
    if (url.includes('/picks/')) {
      return picksResponse([
        { element: 501, position: 12, multiplier: 1, is_captain: false, is_vice_captain: false }
      ]);
    }
    return null;
  });
  const dynamoMock1 = installIngesterDynamoMock({ currentSeason: '2025/26' });

  let firstKey;
  try {
    await handler({});
    const gw20Writes = dynamoMock1.batchWrites.filter((w) => w.PutRequest.Item.gameweek === 20);
    assert.strictEqual(gw20Writes.length, 1);
    firstKey = gw20Writes[0].PutRequest.Item.position_player;
    assert.strictEqual(firstKey, '501', 'Sort key should be the player id alone, not position-dependent');
  } finally {
    fetchMock1.restore();
    dynamoMock1.restore();
  }

  // Run 2 (a later poll of the SAME gameweek, per gwsToFetch's activeGW-1..activeGW
  // window): FPL's auto-substitution has now promoted element 501 into the starting XI
  // (position 7) -- same player, same gameweek, different `position`.
  const fetchMock2 = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/20/live/')) return liveStatsResponse({ 501: 6 });
    if (url.includes('/picks/')) {
      return picksResponse([
        { element: 501, position: 7, multiplier: 1, is_captain: false, is_vice_captain: false }
      ]);
    }
    return null;
  });
  const dynamoMock2 = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    const gw20Writes = dynamoMock2.batchWrites.filter((w) => w.PutRequest.Item.gameweek === 20);
    assert.strictEqual(gw20Writes.length, 1);
    const secondKey = gw20Writes[0].PutRequest.Item.position_player;
    assert.strictEqual(secondKey, '501');
    assert.strictEqual(secondKey, firstKey, 'Same player, same gameweek, changed position -- sort key must stay identical so a real PutCommand overwrites instead of leaving a duplicate behind');

    // squad_position itself (a separate, non-key attribute) SHOULD reflect the new
    // position -- only the sort key needs to be stable, not the pick's actual data.
    assert.strictEqual(gw20Writes[0].PutRequest.Item.squad_position, 7);
  } finally {
    fetchMock2.restore();
    dynamoMock2.restore();
  }
});

test('[fixed] two different players in the same gameweek still get two distinct sort keys', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: buildMidSeasonEvents(20, 38), elements: [] }));
    if (url.includes('leagues-classic')) return jsonResponse({ standings: { results: [SAMPLE_MANAGER] } });
    if (url.includes('/event/20/live/')) return liveStatsResponse({ 501: 6, 502: 3 });
    if (url.includes('/picks/')) {
      return picksResponse([
        { element: 501, position: 1, multiplier: 1, is_captain: false, is_vice_captain: false },
        { element: 502, position: 2, multiplier: 1, is_captain: false, is_vice_captain: false }
      ]);
    }
    return null;
  });
  const dynamoMock = installIngesterDynamoMock({ currentSeason: '2025/26' });

  try {
    await handler({});
    const gw20Writes = dynamoMock.batchWrites.filter((w) => w.PutRequest.Item.gameweek === 20);
    const keys = gw20Writes.map((w) => w.PutRequest.Item.position_player).sort();
    assert.deepStrictEqual(keys, ['501', '502']);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
