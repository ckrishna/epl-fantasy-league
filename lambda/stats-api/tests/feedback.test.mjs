// EVAL: Help page "send feedback" form -- utils/feedback-log.mjs + handlers/feedback.mjs.
//
// This form exists specifically so managers don't have to email the app owner directly
// (see the Help page redesign discussion) -- writes straight to DynamoDB, no SES email
// on submit, so there's no risk of getting bombarded with real-time inbox pings. That
// design choice is why there's no "notify" test here the way genbi-budget has one: the
// whole point is that nothing fires on submit besides a DB write.
//
// Covers: required-message validation, message length floor and cap, light email
// sanity check, the honeypot bot-trap (silently accepted, never written), the IP-based
// rate limit (real guard against someone mashing submit), and the happy path.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handleFeedbackSubmit } from '../handlers/feedback.mjs';

test('[current bug] rejects a missing message with 400', async () => {
  const result = await handleFeedbackSubmit({}, '1.2.3.4', {});
  assert.strictEqual(result.statusCode, 400);
});

test('[current bug] rejects a whitespace-only message with 400', async () => {
  const result = await handleFeedbackSubmit({ message: '   ' }, '1.2.3.4', {});
  assert.strictEqual(result.statusCode, 400);
});

test('[current bug] rejects a message over the length cap with 400', async () => {
  const result = await handleFeedbackSubmit({ message: 'x'.repeat(2001) }, '1.2.3.4', {});
  assert.strictEqual(result.statusCode, 400);
});

test('[current bug] rejects a message under 15 characters with 400', async () => {
  const result = await handleFeedbackSubmit({ message: 'too short' }, '1.2.3.4', {});
  assert.strictEqual(result.statusCode, 400);
  const body = JSON.parse(result.body);
  assert.match(body.error, /15/);
});

test('[regression] a message of exactly 15 characters is accepted, not rejected as too short', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'ScanCommand') {
      return { Items: [] };
    }
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'PutCommand') {
      return {};
    }
    return undefined;
  });

  try {
    const fifteenChars = 'x'.repeat(15);
    assert.strictEqual(fifteenChars.length, 15);
    const result = await handleFeedbackSubmit({ message: fifteenChars }, '1.2.3.4', {});
    assert.strictEqual(result.statusCode, 200);
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] length is checked against the trimmed message, not the raw one', async () => {
  // 20 spaces + "hi" trims down to 2 characters -- should still be rejected as too
  // short, not accepted just because the raw (untrimmed) string is long.
  const result = await handleFeedbackSubmit({ message: `${' '.repeat(20)}hi` }, '1.2.3.4', {});
  assert.strictEqual(result.statusCode, 400);
});

test('[current bug] rejects an email missing an "@" with 400, message is otherwise valid', async () => {
  const result = await handleFeedbackSubmit(
    { message: 'Love the app, great work overall!', email: 'not-an-email' },
    '1.2.3.4',
    {}
  );
  assert.strictEqual(result.statusCode, 400);
});

test('[current bug] honeypot field silently accepted (200) without writing to DynamoDB', async () => {
  const dynamoMock = installDynamoMock(() => {
    throw new Error('Expected no DynamoDB call at all for a honeypot-tripped submission');
  });

  try {
    const result = await handleFeedbackSubmit(
      { message: 'buy my product', website: 'http://spam.example' },
      '1.2.3.4',
      {}
    );
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.success, true);
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] rate-limits a second submission from the same IP within the window', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'ScanCommand') {
      // Simulate an existing recent submission from this IP.
      return { Items: [{ source_ip: '1.2.3.4', timestamp: new Date().toISOString() }] };
    }
    return undefined;
  });

  try {
    const result = await handleFeedbackSubmit({ message: 'sending this again' }, '1.2.3.4', {});
    assert.strictEqual(result.statusCode, 429);
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] a null source IP is never rate-limited (fails open, not closed)', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'PutCommand') {
      return {};
    }
    throw new Error(`Unexpected DynamoDB call: ${command.constructor.name}`);
  });

  try {
    const result = await handleFeedbackSubmit({ message: 'hello there, team!' }, null, {});
    assert.strictEqual(result.statusCode, 200);
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] a rate-limit check failure (DynamoDB error) does not block a real submission', async () => {
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'ScanCommand') {
      throw new Error('simulated DynamoDB throttling');
    }
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'PutCommand') {
      return {};
    }
    return undefined;
  });

  try {
    const result = await handleFeedbackSubmit({ message: 'hello there, team!' }, '5.6.7.8', {});
    assert.strictEqual(result.statusCode, 200, 'A rate-limit check failure should fail open, not block the submission');
  } finally {
    dynamoMock.restore();
  }
});

test('[current bug] happy path writes message + email + source_ip to app-feedback and returns 200', async () => {
  let putCommand;
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'ScanCommand') {
      return { Items: [] };
    }
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'PutCommand') {
      putCommand = command;
      return {};
    }
    return undefined;
  });

  try {
    const result = await handleFeedbackSubmit(
      { message: 'Love the new look!', email: 'chetan@example.com' },
      '9.9.9.9',
      {}
    );
    assert.strictEqual(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.success, true);

    assert.ok(putCommand, 'Expected a PutCommand against app-feedback');
    assert.strictEqual(putCommand.input.Item.message, 'Love the new look!');
    assert.strictEqual(putCommand.input.Item.email, 'chetan@example.com');
    assert.strictEqual(putCommand.input.Item.source_ip, '9.9.9.9');
    assert.ok(putCommand.input.Item.feedback_id, 'Expected a generated feedback_id');
    assert.ok(putCommand.input.Item.timestamp, 'Expected a timestamp');
  } finally {
    dynamoMock.restore();
  }
});

test('[regression] an omitted email is stored as null, not an empty string', async () => {
  let putCommand;
  const dynamoMock = installDynamoMock((command) => {
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'ScanCommand') {
      return { Items: [] };
    }
    if (command.input.TableName === 'app-feedback' && command.constructor.name === 'PutCommand') {
      putCommand = command;
      return {};
    }
    return undefined;
  });

  try {
    await handleFeedbackSubmit({ message: 'Anonymous feedback' }, '9.9.9.9', {});
    assert.strictEqual(putCommand.input.Item.email, null);
  } finally {
    dynamoMock.restore();
  }
});
