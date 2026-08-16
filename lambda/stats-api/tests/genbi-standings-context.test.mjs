// EVAL: handleGenBI() wires real league standings (points + rank) into context.
//
// Bug: GenBI never queried fpl_league_standings at all -- confirmed live by asking
// "what is our league standings?" and getting "I cannot provide league standings
// because the necessary data is not included in the context provided." total_season_
// summary/recent_form_summary only ever held WIN COUNTS (from gw-winners-cache), never
// total points or rank -- the same table handleStandings already reads for the
// dashboard's own Standings page. Fixed by reusing queryLeagueStandings() (from
// utils/dynamodb.mjs) to populate a new current_standings context field, sorted by
// total_points with rank computed, same walk-back-a-gameweek behavior as
// handleStandings in case fpl_league_standings has a gap independent of the other
// tables (e.g. the GW26 outage documented in DATA_MODEL.md).
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installBedrockMock, systemText } from './helpers/mock-bedrock.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

// Requesting a *historical* season (2025/26, with 2026/27 marked current) so gameweek
// resolution goes through getLatestStoredGameweek (a DynamoDB scan) instead of
// getActiveGameweek (a live FPL fetch) -- same pattern as genbi-season-scoping.test.mjs.
function baseDynamoRouter(overrides = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      if (command.input.FilterExpression) {
        return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
      }
      return { Items: [{ season_id: 1, season_string: '2025/26' }, { season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_season_totals' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [{ gameweek: 10 }] };
    if (table === 'fpl_league_standings' && type === 'QueryCommand') {
      return overrides.standings ? overrides.standings(command) : { Items: [] };
    }
    return undefined;
  };
}

test('[current bug] current_standings reaches the Bedrock context, sorted by points with rank computed', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    standings: () => ({
      Items: [
        { season_event: '2025/26#10', manager_id: 1, team_nickname: 'Suberox', real_name: 'Suberox FC', total_points: 480, points_this_week: 55 },
        { season_event: '2025/26#10', manager_id: 2, team_nickname: 'Da Movement', real_name: 'Da Movement FC', total_points: 512, points_this_week: 60 }
      ]
    })
  }));
  const bedrockMock = installBedrockMock('Da Movement leads with 512 points.');

  try {
    const result = await handleGenBI({ question: 'What are our league standings?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);

    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const standings = JSON.parse(contextBlock.match(/<current_standings>(.*?)<\/current_standings>/)[1]);

    assert.strictEqual(standings.length, 2);
    // manager is "real name (nickname)" -- real_name is the real name, team_nickname the
    // FPL squad nickname (see formatManagerDisplay's comment in genbi.mjs).
    assert.strictEqual(standings[0].manager, 'Da Movement FC (Da Movement)', 'Expected standings sorted by total_points descending');
    assert.strictEqual(standings[0].rank, 1);
    assert.strictEqual(standings[0].total_points, 512);
    assert.strictEqual(standings[1].manager, 'Suberox FC (Suberox)');
    assert.strictEqual(standings[1].rank, 2);

    assert.match(systemText(payload), /STANDINGS:/, 'Expected an explicit instruction routing standings questions to current_standings');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] walks back a gameweek if fpl_league_standings has a gap at the resolved gameweek', async () => {
  let calls = 0;
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    standings: (command) => {
      calls += 1;
      const gw = command.input.ExpressionAttributeValues[':se'];
      if (gw.endsWith('#10')) return { Items: [] }; // gap at gw 10
      if (gw.endsWith('#9')) {
        return { Items: [{ season_event: '2025/26#9', manager_id: 1, team_nickname: 'Suberox', real_name: 'Suberox FC', total_points: 425, points_this_week: 40 }] };
      }
      return { Items: [] };
    }
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'What are our league standings?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const standings = JSON.parse(contextBlock.match(/<current_standings>(.*?)<\/current_standings>/)[1]);
    assert.strictEqual(standings.length, 1);
    assert.strictEqual(standings[0].manager, 'Suberox FC (Suberox)');
    assert.ok(calls >= 2, 'Expected at least two queries (gw10 gap, then gw9 fallback)');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] total_season_summary (win counts) is unaffected by the new standings field', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter());
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who has the most GW wins?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(systemText(payload), /<total_season_summary>/);
    assert.match(systemText(payload), /MANAGER WIN COUNTS/);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
