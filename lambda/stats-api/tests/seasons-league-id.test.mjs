// EVAL: handleSeasons() exposes league_id.
//
// Bug: league_id already lives on the seasons table row (added 2026-07-30 so a
// league-ID change is a data update, not a redeploy), but handleSeasons never returned
// it -- the frontend header hardcoded "Carpe Diem - League 438107" as static text
// instead of reading it dynamically, which is exactly the hardcoded-value problem the
// backend change was meant to avoid. Needed so the frontend can build a combined
// "League {id} - {season}" label per season, including for a season whose league_id
// might differ from the current one.
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handleSeasons } from '../handlers/seasons.mjs';

test('[current bug] league_id is included per season in the /seasons response', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'seasons' && command.constructor.name === 'ScanCommand') {
      return {
        Items: [
          { season_id: 1, season_string: '2025/26', current: false, league_id: 212889 },
          { season_id: 2, season_string: '2026/27', current: true, league_id: 438107 }
        ]
      };
    }
    return undefined;
  });

  try {
    const result = await handleSeasons({});
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    const bySeason = Object.fromEntries(body.seasons.map((s) => [s.season, s]));
    assert.strictEqual(bySeason['2025/26'].league_id, 212889,
      'Expected 2025/26\'s own league_id, not the current season\'s');
    assert.strictEqual(bySeason['2026/27'].league_id, 438107);
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] missing league_id on an older row falls back to null, not a crash', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'seasons' && command.constructor.name === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    return undefined;
  });

  try {
    const result = await handleSeasons({});
    const body = JSON.parse(result.body);
    assert.strictEqual(body.seasons[0].league_id, null);
  } finally {
    dynamoMock.restore();
  }
});
