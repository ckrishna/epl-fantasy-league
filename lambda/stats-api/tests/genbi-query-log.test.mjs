// EVAL: structured Q&A logging for GenBI (utils/genbi-log.mjs + its wiring into
// handlers/genbi.mjs's handleGenBI).
//
// This is the foundation the upcoming thumbs-up/down feature builds on: every answered
// question needs a durable row (question, which router fields were selected, answer,
// tokens, cost, duration) plus a query_id the frontend can hold onto to later attach
// feedback to. Without this log existing first, thumbs-up/down would have nothing to
// reference.
//
// Run BEFORE the fix: expect FAIL (module doesn't exist / genbi.mjs doesn't call it /
// response has no query_id).
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { recordQueryLog } from '../utils/genbi-log.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

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
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [{ gameweek: 10 }] };
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    if (overrides.router) {
      const result = overrides.router(table, type, command);
      if (result !== undefined) return result;
    }
    return undefined;
  };
}

test('[current bug] recordQueryLog() writes a row to genbi-query-log with the expected shape', async () => {
  let putCommand;
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-query-log' && command.constructor.name === 'PutCommand') {
      putCommand = command;
      return {};
    }
    return undefined;
  });

  try {
    const queryId = await recordQueryLog({
      question: 'What are our standings?',
      season: '2025/26',
      gameweek: 10,
      fieldsSelected: { standings: true, seasonWins: false, recentForm: false, playerGwData: false, seasonTotals: false, managerPicks: false },
      answer: 'Team A is leading.',
      inputTokens: 500,
      outputTokens: 40,
      costUsd: 0.00077,
      durationMs: 900
    });

    assert.ok(typeof queryId === 'string' && queryId.length > 0, 'Expected recordQueryLog to return a non-empty query_id');
    assert.ok(putCommand, 'Expected a PutCommand against genbi-query-log');
    const item = putCommand.input.Item;
    assert.strictEqual(item.query_id, queryId);
    assert.strictEqual(item.question, 'What are our standings?');
    assert.strictEqual(item.season, '2025/26');
    assert.strictEqual(item.gameweek, 10);
    assert.deepStrictEqual(item.fields_selected, { standings: true, seasonWins: false, recentForm: false, playerGwData: false, seasonTotals: false, managerPicks: false });
    assert.strictEqual(item.answer, 'Team A is leading.');
    assert.strictEqual(item.input_tokens, 500);
    assert.strictEqual(item.output_tokens, 40);
    assert.strictEqual(item.cost_usd, 0.00077);
    assert.strictEqual(item.duration_ms, 900);
    assert.strictEqual(item.feedback, null, 'feedback should start out null, reserved for thumbs-up/down');
    assert.ok(typeof item.timestamp === 'string' && item.timestamp.length > 0);
    assert.strictEqual(item.date, item.timestamp.slice(0, 10));
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] a write failure does not throw -- still returns a query_id', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-query-log' && command.constructor.name === 'PutCommand') {
      throw new Error('simulated DynamoDB failure');
    }
    return undefined;
  });

  try {
    const queryId = await recordQueryLog({
      question: 'Anything?',
      season: '2025/26',
      gameweek: 1,
      fieldsSelected: {},
      answer: 'Something.',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      durationMs: 1
    });
    assert.ok(typeof queryId === 'string' && queryId.length > 0);
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] handleGenBI writes a query log entry and returns query_id in the response', async () => {
  let loggedItem;
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    router: (table, type, command) => {
      if (table === 'genbi-query-log' && type === 'PutCommand') {
        loggedItem = command.input.Item;
        return {};
      }
      return undefined;
    }
  }));
  const bedrockMock = installBedrockMock('The standings say Team A is first.', { inputTokens: 300, outputTokens: 25 });

  try {
    const result = await handleGenBI({ question: 'What are our current standings?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);

    assert.ok(body.query_id, 'Expected the response to include a query_id');
    assert.ok(loggedItem, 'Expected handleGenBI to have written a genbi-query-log row');
    assert.strictEqual(loggedItem.query_id, body.query_id, 'Logged row and response should share the same query_id');
    assert.strictEqual(loggedItem.question, 'What are our current standings?');
    assert.strictEqual(loggedItem.answer, 'The standings say Team A is first.');
    assert.strictEqual(loggedItem.input_tokens, 300);
    assert.strictEqual(loggedItem.output_tokens, 25);
    assert.strictEqual(loggedItem.fields_selected.standings, true,
      'Expected the router\'s field selection to be captured in the log, not just the raw question');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
