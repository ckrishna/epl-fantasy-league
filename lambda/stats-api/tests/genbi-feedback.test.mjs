// EVAL: thumbs-up/down feedback for GenBI (utils/genbi-log.mjs's submitFeedback() +
// handlers/genbi.mjs's handleGenBIFeedback()).
//
// Builds directly on the structured Q&A log (genbi-query-log.test.mjs): feedback is
// attached to an already-logged question by its query_id. Validates input shape,
// distinguishes "no such query_id" (404) from a real write failure (500), and confirms
// a real DynamoDB conditional-check failure (not just a hand-rolled mock response) is
// what actually produces the "not found" path -- see the second test below.
//
// Run BEFORE the fix: expect FAIL (handleGenBIFeedback doesn't exist yet).
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { submitFeedback } from '../utils/genbi-log.mjs';
import { handleGenBIFeedback } from '../handlers/genbi.mjs';

test('[current bug] submitFeedback() writes feedback + feedback_at when the query_id exists', async () => {
  let updateCommand;
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-query-log' && command.constructor.name === 'UpdateCommand') {
      updateCommand = command;
      return {};
    }
    return undefined;
  });

  try {
    const result = await submitFeedback({ queryId: 'abc-123', feedback: 'up' });
    assert.strictEqual(result.success, true);
    assert.ok(updateCommand, 'Expected an UpdateCommand against genbi-query-log');
    assert.strictEqual(updateCommand.input.Key.query_id, 'abc-123');
    assert.strictEqual(updateCommand.input.ExpressionAttributeValues[':f'], 'up');
    assert.ok(updateCommand.input.ConditionExpression.includes('attribute_exists'),
      'Expected a conditional update so feedback against an unknown query_id fails loudly instead of creating a new row');
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] submitFeedback() reports notFound when the conditional check fails, not a generic failure', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-query-log' && command.constructor.name === 'UpdateCommand') {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    return undefined;
  });

  try {
    const result = await submitFeedback({ queryId: 'does-not-exist', feedback: 'down' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.notFound, true);
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] submitFeedback() reports a generic (non-notFound) failure for any other error', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-query-log' && command.constructor.name === 'UpdateCommand') {
      throw new Error('simulated throttling or network failure');
    }
    return undefined;
  });

  try {
    const result = await submitFeedback({ queryId: 'abc-123', feedback: 'up' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.notFound, false);
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] handleGenBIFeedback rejects a missing query_id with 400', async () => {
  const result = await handleGenBIFeedback({ feedback: 'up' }, {});
  assert.strictEqual(result.statusCode, 400);
});

test('[current bug] handleGenBIFeedback rejects an invalid feedback value with 400', async () => {
  const result = await handleGenBIFeedback({ query_id: 'abc-123', feedback: 'sideways' }, {});
  assert.strictEqual(result.statusCode, 400);
});

test('[current bug] handleGenBIFeedback returns 404 for an unknown query_id', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-query-log' && command.constructor.name === 'UpdateCommand') {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    return undefined;
  });

  try {
    const result = await handleGenBIFeedback({ query_id: 'does-not-exist', feedback: 'up' }, {});
    assert.strictEqual(result.statusCode, 404);
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] handleGenBIFeedback returns 200 with the recorded feedback on success', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'genbi-query-log' && command.constructor.name === 'UpdateCommand') {
      return {};
    }
    return undefined;
  });

  try {
    const result = await handleGenBIFeedback({ query_id: 'abc-123', feedback: 'down' }, {});
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.query_id, 'abc-123');
    assert.strictEqual(body.feedback, 'down');
  } finally {
    dynamoMock.restore();
  }
});
