// EVAL: handleGenBI() wired to the daily budget guardrail (utils/genbi-budget.mjs).
//
// Requirement: once today's Bedrock spend has reached the daily cap, handleGenBI must
// refuse to call Bedrock at all (zero further cost) and say so clearly. Below the cap,
// it must behave exactly as before and record the real cost of each call it makes.
//
// Run BEFORE the fix: expect FAIL on the tests marked "current bug".
// Run AFTER the fix: expect all tests to PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';
import { DAILY_BUDGET_USD } from '../utils/genbi-budget.mjs';

const TODAY = new Date().toISOString().slice(0, 10);

function baseDynamoRouter({ todaysCost = 0, warned = false } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;

    if (table === 'genbi-usage-daily' && type === 'GetCommand') {
      return { Item: { date: TODAY, cost_usd: todaysCost, warned } };
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

function installFplFetchMock() {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
}

test('[current bug] blocks the Bedrock call once today\'s spend has reached the daily cap', async () => {
  const fetchMock = installFplFetchMock();
  const dynamoMock = installDynamoMock(baseDynamoRouter({ todaysCost: DAILY_BUDGET_USD, warned: true }));
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who should I captain?' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bedrockMock.calls.length, 0,
      'Expected zero Bedrock calls once the daily budget is exhausted -- a blocked request must cost nothing.');
    const body = JSON.parse(result.body);
    assert.strictEqual(body.budget_exceeded, true);
    assert.match(body.answer, /budget/i);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[regression] still calls Bedrock and answers normally when comfortably under budget', async () => {
  const fetchMock = installFplFetchMock();
  const dynamoMock = installDynamoMock(baseDynamoRouter({ todaysCost: 0.50, warned: false }));
  const bedrockMock = installBedrockMock('Captain the in-form striker.', { inputTokens: 4000, outputTokens: 300 });

  try {
    const result = await handleGenBI({ question: 'Who should I captain?' }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(bedrockMock.calls.length, 1);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.answer, 'Captain the in-form striker.');
    assert.notStrictEqual(body.budget_exceeded, true);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('[current bug] records the real cost of a successful call against today\'s total', async () => {
  const fetchMock = installFplFetchMock();
  let capturedAdd = null;
  const router = baseDynamoRouter({ todaysCost: 0.10, warned: false });
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-usage-daily' && command.constructor.name === 'UpdateCommand') {
      capturedAdd = command;
    }
    return router(command);
  });
  const bedrockMock = installBedrockMock('Answer.', { inputTokens: 4000, outputTokens: 300 });

  try {
    await handleGenBI({ question: 'Who should I captain?' }, {});
    assert.ok(capturedAdd, 'Expected an UpdateCommand recording usage against genbi-usage-daily');
    const addedCost = capturedAdd.input.ExpressionAttributeValues[':c'];
    const expectedCost = (4000 * 3.30 / 1_000_000) + (300 * 16.50 / 1_000_000);
    assert.ok(Math.abs(addedCost - expectedCost) < 1e-9,
      `Expected the recorded cost to reflect the real usage (${expectedCost}), got ${addedCost}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
