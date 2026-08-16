// EVAL: askClaude() in utils/bedrock.mjs, invoked via handleGenBI()
//
// Bug: Bedrock has marked anthropic.claude-3-haiku-20240307-v1:0 as a legacy model and
// denies access to it -- confirmed live via a curl to /stats/query returning:
//   "Access denied. This Model is marked by provider as Legacy..."
// That model ID was hardcoded in TWO places (genbi.mjs's inline callClaudeWithContext
// and a dead, unused duplicate callClaude in utils/bedrock.mjs) -- the same "hardcoded
// value duplicated, only one copy gets fixed" pattern as LEAGUE_ID and the gameweek
// fallback. Consolidated into one function in utils/bedrock.mjs.
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';
import { CLAUDE_MODEL_ID, askClaude } from '../utils/bedrock.mjs';

const DEPRECATED_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

function baseDynamoRouter() {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') {
      return { Item: undefined };
    }
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') {
      return {};
    }
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    return undefined;
  };
}

test('[current bug] CLAUDE_MODEL_ID is not the deprecated/access-denied model', () => {
  assert.notStrictEqual(CLAUDE_MODEL_ID, DEPRECATED_MODEL_ID,
    `CLAUDE_MODEL_ID is still set to the deprecated model (${DEPRECATED_MODEL_ID}) that Bedrock has ` +
    `denied access to. This is what caused the live "Access denied. This Model is marked by provider as ` +
    `Legacy" error on /stats/query.`);
});

test('[current bug] handleGenBI invokes Bedrock with the current model ID, not the deprecated one', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter());
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bedrockMock.calls.length, 1, 'Expected exactly one Bedrock InvokeModelCommand');
    const invokedModelId = bedrockMock.calls[0].input.modelId;
    assert.notStrictEqual(invokedModelId, DEPRECATED_MODEL_ID,
      `handleGenBI invoked Bedrock with the deprecated model ID (${DEPRECATED_MODEL_ID}). This means ` +
      `genbi.mjs is still using its own inline duplicate instead of the shared, fixed askClaude().`);
    assert.strictEqual(invokedModelId, CLAUDE_MODEL_ID);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] askClaude still returns the response text and usage from Bedrock', async () => {
  const bedrockMock = installBedrockMock('Yash is in the best form.', { inputTokens: 123, outputTokens: 45 });
  try {
    const result = await askClaude('Who is in form?', {
      gameweek: 1,
      recent_form_summary: {},
      total_season_summary: {},
      players_gw_data: [],
      our_league_picks: []
    });
    assert.strictEqual(result.response, 'Yash is in the best form.');
    assert.strictEqual(result.usage.input_tokens, 123);
    assert.strictEqual(result.usage.output_tokens, 45);
  } finally {
    bedrockMock.restore();
  }
});

// Regression for the 2026-08-16 non-determinism investigation: the exact same populated
// <fixture_run> context produced a correct answer from Sonnet 4.6 once (via
// scripts/debug-fixture-run.mjs) and a flat "I don't have fixture data" decline on live
// production traffic the next call -- same data, different outcome, because the request
// never pinned a temperature and Bedrock defaults to 1.0. Locks in that askClaude()
// always sends temperature: 0, so this class of bug (confirmed live, not hypothetical)
// doesn't silently regress in a future edit to the payload.
test('[regression] askClaude pins temperature to 0 so identical context reliably produces identical output', async () => {
  const bedrockMock = installBedrockMock('ok');
  try {
    await askClaude('Who has good fixtures coming up?', {
      gameweek: 1,
      recent_form_summary: {},
      total_season_summary: {},
      players_gw_data: [],
      our_league_picks: []
    });
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.strictEqual(payload.temperature, 0,
      'Bedrock defaults to temperature 1.0 when this is omitted -- confirmed live to cause the same ' +
      'populated context to sometimes produce a correct answer and sometimes a false decline.');
  } finally {
    bedrockMock.restore();
  }
});
