// EVAL: utils/genbi-budget.mjs -- the daily cost guardrail for GenBI's Bedrock usage.
//
// Requirement: GenBI must never let Bedrock spend run unchecked. A $25/day hard cap,
// computed from real token usage at the currently-configured model's actual Bedrock
// rates (Claude Sonnet 5 as of 2026-08-16, switched from Haiku 4.5 -- see bedrock.mjs's
// CLAUDE_MODEL_ID comment), blocks further calls once hit; a warning fires once per day
// at 80% of budget.
//
// Run BEFORE this file existed: N/A (new module). Run against a broken/no-op
// implementation: expect FAIL. Run against the real implementation: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import {
  computeCostUsd,
  getTodayUsage,
  checkBudget,
  recordUsage,
  markWarned,
  DAILY_BUDGET_USD,
  WARNING_THRESHOLD_RATIO
} from '../utils/genbi-budget.mjs';

const TODAY = new Date().toISOString().slice(0, 10);

test('computeCostUsd uses Sonnet 5 Bedrock rates ($2.20/1M in, $11.00/1M out)', () => {
  const cost = computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(Math.abs(cost - 13.20) < 0.0001, `Expected $13.20 for 1M in + 1M out, got $${cost}`);
});

test('[current bug] getTodayUsage defaults to $0/not-warned when no row exists yet', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-usage-daily' && command.constructor.name === 'GetCommand') {
      return { Item: undefined };
    }
    return undefined;
  });
  try {
    const usage = await getTodayUsage();
    assert.strictEqual(usage.cost_usd, 0);
    assert.strictEqual(usage.warned, false);
    assert.strictEqual(usage.date, TODAY);
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] checkBudget blocks once today\'s spend reaches the daily cap', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-usage-daily' && command.constructor.name === 'GetCommand') {
      return { Item: { date: TODAY, cost_usd: DAILY_BUDGET_USD, warned: true } };
    }
    return undefined;
  });
  try {
    const result = await checkBudget();
    assert.strictEqual(result.overBudget, true, 'Expected overBudget=true once cost_usd >= DAILY_BUDGET_USD');
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] checkBudget does NOT block while under the daily cap', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-usage-daily' && command.constructor.name === 'GetCommand') {
      return { Item: { date: TODAY, cost_usd: 1.23, warned: false } };
    }
    return undefined;
  });
  try {
    const result = await checkBudget();
    assert.strictEqual(result.overBudget, false);
    assert.strictEqual(result.costSoFar, 1.23);
  } finally {
    dynamoMock.restore();
  }
});

test(`[current bug] checkBudget flags shouldWarn once spend crosses ${WARNING_THRESHOLD_RATIO * 100}% of budget, not before`, async () => {
  const justUnderThreshold = DAILY_BUDGET_USD * WARNING_THRESHOLD_RATIO - 0.01;
  const justOverThreshold = DAILY_BUDGET_USD * WARNING_THRESHOLD_RATIO + 0.01;

  const dynamoMockUnder = installDynamoMock(() => ({ Item: { date: TODAY, cost_usd: justUnderThreshold, warned: false } }));
  try {
    const result = await checkBudget();
    assert.strictEqual(result.shouldWarn, false, 'Should not warn before crossing the threshold');
  } finally {
    dynamoMockUnder.restore();
  }

  const dynamoMockOver = installDynamoMock(() => ({ Item: { date: TODAY, cost_usd: justOverThreshold, warned: false } }));
  try {
    const result = await checkBudget();
    assert.strictEqual(result.shouldWarn, true, 'Should warn once past the threshold and not yet warned');
  } finally {
    dynamoMockOver.restore();
  }
});

test('[current bug] checkBudget does NOT re-flag shouldWarn once already warned today', async () => {
  const dynamoMock = installDynamoMock(() => ({
    Item: { date: TODAY, cost_usd: DAILY_BUDGET_USD * 0.95, warned: true }
  }));
  try {
    const result = await checkBudget();
    assert.strictEqual(result.shouldWarn, false, 'Should not warn again once warned=true for today');
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] recordUsage atomically adds the real cost of a call to today\'s total', async () => {
  let capturedUpdate = null;
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-usage-daily' && command.constructor.name === 'UpdateCommand') {
      capturedUpdate = command;
      return {};
    }
    return undefined;
  });
  try {
    const cost = await recordUsage({ inputTokens: 4000, outputTokens: 500 });
    const expectedCost = computeCostUsd({ inputTokens: 4000, outputTokens: 500 });
    assert.ok(Math.abs(cost - expectedCost) < 1e-9);
    assert.ok(capturedUpdate, 'Expected an UpdateCommand against genbi-usage-daily');
    assert.strictEqual(capturedUpdate.input.Key.date, TODAY);
    assert.match(capturedUpdate.input.UpdateExpression, /ADD cost_usd/,
      'Expected an atomic ADD so concurrent requests do not clobber each other\'s writes');
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] markWarned sets warned=true for today so the email only fires once', async () => {
  let capturedUpdate = null;
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-usage-daily' && command.constructor.name === 'UpdateCommand') {
      capturedUpdate = command;
      return {};
    }
    return undefined;
  });
  try {
    await markWarned();
    assert.ok(capturedUpdate);
    assert.strictEqual(capturedUpdate.input.Key.date, TODAY);
    assert.strictEqual(capturedUpdate.input.ExpressionAttributeValues[':true'], true);
  } finally {
    dynamoMock.restore();
  }
});
