// EVAL: player-level `form` field reaching GenBI's context (handlers/genbi.mjs) and
// being disambiguated from manager-level form in the prompt (utils/bedrock.mjs).
//
// Gap: fpl-global-stats-weekly already writes `form: player.form || 0` to every
// player_event_stats row (FPL's own official rolling recent-performance score for that
// player) -- confirmed in DATA_MODEL.md and the ingester source. But genbi.mjs's
// players_gw_data mapping never read it, so a question like "which players are in
// form?" had no player-level form data to answer from at all -- only
// recent_form_summary, which is a completely different thing (manager win-streaks).
// Two fields sharing the word "form" with no data and no prompt rule to tell them
// apart was a live gap, not a hypothetical one.
//
// Run BEFORE the fix: expect FAIL on the tests marked "current bug".
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

function realisticPlayerRow({ name, total_points, team_id, form }) {
  return {
    name,
    total_points,
    team_id,
    form,
    selected_by_percent: '10.0',
    gameweek_player: `38#${name}`
  };
}

function baseDynamoRouter(playerItems) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: playerItems };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    return undefined;
  };
}

test('[current bug] players_gw_data sent to Claude includes each player\'s real form value', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter([
    realisticPlayerRow({ name: 'Salah', total_points: 18, team_id: 11, form: 7.4 })
  ]));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Which players are in form?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const playerDataMatch = payload.system.match(/<player_data>(.*?)<\/player_data>/s);
    assert.ok(playerDataMatch, 'Expected <player_data> in the system prompt sent to Claude');
    const playerData = JSON.parse(playerDataMatch[1]);
    assert.strictEqual(playerData[0].form, 7.4,
      `Expected Salah's real form (7.4) to reach Claude, got ${playerData[0].form}. This means genbi.mjs's ` +
      `players_gw_data mapping is still dropping the form field that player_event_stats already carries.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] a missing/undefined form value defaults to 0, not NaN or undefined', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter([
    realisticPlayerRow({ name: 'NoFormData', total_points: 5, team_id: 1, form: undefined })
  ]));
  const bedrockMock = installBedrockMock();

  try {
    await handleGenBI({ question: 'Which players are in form?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const playerData = JSON.parse(payload.system.match(/<player_data>(.*?)<\/player_data>/s)[1]);
    assert.strictEqual(playerData[0].form, 0);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] the system prompt disambiguates PLAYER FORM from MANAGER FORM', async () => {
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [{ gameweek: 10 }] };
    return undefined;
  });
  const bedrockMock = installBedrockMock();

  try {
    await handleGenBI({ question: 'Which managers are in form?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.ok(payload.system.includes('PLAYER FORM'),
      'Expected the prompt to define PLAYER FORM as distinct from MANAGER FORM, so a small model has an explicit rule instead of guessing which "form" field a question means.');
    assert.ok(payload.system.includes('MANAGER FORM'));
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
