// EVAL: GH #40 -- topic-scope guardrail. Before this fix, GenBI declined off-topic
// questions (e.g. real-world politics) only as an emergent side effect of the <role>
// persona framing in bedrock.mjs -- nothing in the prompt actually told Claude to do
// that, and nothing tested it. Confirmed live 2026-08-16: a "who will win the mid-term
// elections" question got a reasonable decline, but that was luck, not a guarantee --
// the prompt said nothing about topic scope at all.
//
// Since every genbi-*.test.mjs mocks Bedrock entirely (see genbi-next-gw-projections.
// test.mjs's header comment for the same caveat), this can only prove the instruction
// reaches the prompt, not that Claude reliably follows it -- that's what
// scripts/eval-genbi-live.mjs (real Bedrock calls) is for. This still catches the
// regression that matters most here: the instruction disappearing from the prompt
// entirely in some future refactor.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock, systemText } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

// Mirrors genbi-router-integration.test.mjs's baseDynamoRouter -- a historical season
// (2025/26) so gameweek resolution goes through getLatestStoredGameweek (a DynamoDB
// scan), not a live FPL fetch, and so needsNextGwProjections stays false even though an
// unrecognized question's router fallback sets nextGwStrategy true along with
// everything else -- no bootstrap-static mock needed for this test.
function baseDynamoRouter() {
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
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [{ gameweek: 10 }] };
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_season_totals' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    return undefined;
  };
}

test('the system prompt tells Claude to decline off-topic questions and redirect, not answer from general knowledge', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter());
  const bedrockMock = installBedrockMock('ok');

  try {
    // The exact real-world question that surfaced the gap -- confirmed live to only
    // decline correctly by luck, since nothing in the prompt addressed it directly.
    const result = await handleGenBI({ question: 'Who will win the mid term elections in 2026 for senate?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);

    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(systemText(payload), /TOPIC SCOPE/);
    assert.match(systemText(payload), /do NOT attempt to answer it using your own general knowledge/);
    assert.match(systemText(payload), /real-world politics, elections/);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('the topic-scope instruction survives alongside the forward-looking captain instruction (both present, not overwritten)', async () => {
  const dynamoMock = installDynamoMock(baseDynamoRouter());
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who should I captain next gameweek?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(systemText(payload), /TOPIC SCOPE/);
    assert.match(systemText(payload), /FORWARD-LOOKING QUESTIONS/);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
