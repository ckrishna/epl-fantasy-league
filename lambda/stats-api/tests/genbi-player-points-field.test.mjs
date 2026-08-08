// EVAL: handleGenBI()'s player_event_stats mapping in handlers/genbi.mjs
//
// Bug: player_event_stats rows have no `points` field -- the real field is
// `total_points` (confirmed live via a raw DynamoDB query against 2025/26 GW38 data:
// the item has "total_points" but no "points" key at all). genbi.mjs reads `p.points`,
// which is always undefined, so every player is sent to Claude with 0 points regardless
// of what they actually scored -- this is what produced the live bug report ("all
// players show 0 points for GW38"). It also breaks the "top 50 by points" sort that
// selects which players even get sent to Claude, since every comparison is 0 vs 0.
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

// Shaped exactly like what DynamoDBDocumentClient hands back for a real
// player_event_stats row (auto-unmarshalled -- plain JS values, no .N/.S wrappers).
// Confirmed live: the real field is `total_points`, not `points`.
function realisticPlayerRow({ name, total_points, team_id }) {
  return {
    name,
    total_points,
    team_id,
    selected_by_percent: '10.0',
    gameweek_player: `38#${name}`
  };
}

test('[current bug] player_data sent to Claude reflects real total_points, not a hardcoded 0', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') {
      return { Items: [realisticPlayerRow({ name: 'Salah', total_points: 18, team_id: 11 })] };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    return undefined;
  });
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who scored the most?' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bedrockMock.calls.length, 1);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const systemPrompt = payload.system;
    const playerDataMatch = systemPrompt.match(/<player_data>(.*?)<\/player_data>/s);
    assert.ok(playerDataMatch, 'Expected <player_data> in the system prompt sent to Claude');
    const playerData = JSON.parse(playerDataMatch[1]);
    assert.strictEqual(playerData[0].points, 18,
      `Expected Salah's real total_points (18) to reach Claude, got ${playerData[0].points}. ` +
      `This means genbi.mjs is still reading the nonexistent "points" field instead of "total_points".`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] top-50 selection actually sorts by real points, not a no-op 0-vs-0 comparison', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') {
      return {
        Items: [
          realisticPlayerRow({ name: 'LowScorer', total_points: 2, team_id: 1 }),
          realisticPlayerRow({ name: 'TopScorer', total_points: 22, team_id: 2 }),
          realisticPlayerRow({ name: 'MidScorer', total_points: 10, team_id: 3 })
        ]
      };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    return undefined;
  });
  const bedrockMock = installBedrockMock();

  try {
    await handleGenBI({ question: 'Who scored the most?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const playerDataMatch = payload.system.match(/<player_data>(.*?)<\/player_data>/s);
    const playerData = JSON.parse(playerDataMatch[1]);
    assert.strictEqual(playerData[0].name, 'TopScorer',
      `Expected the highest-scoring player first, got "${playerData[0].name}". The sort is comparing a ` +
      `field that doesn't exist on these rows, so it's not really sorting by points at all.`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
