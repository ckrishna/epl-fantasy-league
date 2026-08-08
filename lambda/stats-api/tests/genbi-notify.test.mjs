// EVAL: sendBudgetWarningEmail() in utils/notify.mjs
//
// NOTE: requires @aws-sdk/client-ses to be installed (`npm install` in lambda/stats-api).
// The sandbox this was authored in has no npm registry access (403 from a security
// policy), so this file could not be executed there -- run `npm test` locally after
// installing the dependency to get the first real red/green result on this file.
//
// Requirement: once GenBI's daily Bedrock spend crosses the warning threshold, exactly
// one email should go out to the configured alert address, containing the current
// spend and the budget limit.

import { test } from 'node:test';
import assert from 'node:assert';
import { installSesMock } from './helpers/mock-ses.mjs';
import { sendBudgetWarningEmail } from '../utils/notify.mjs';

test('sendBudgetWarningEmail sends to the default alert address with spend/limit in the body', async () => {
  const sesMock = installSesMock();
  try {
    await sendBudgetWarningEmail({ costSoFar: 20.5, limit: 25 });
    assert.strictEqual(sesMock.calls.length, 1, 'Expected exactly one SES SendEmailCommand');
    const input = sesMock.calls[0].input;
    assert.strictEqual(input.Destination.ToAddresses[0], 'chetanbk@gmail.com');
    assert.match(input.Message.Subject.Data, /20\.50/);
    assert.match(input.Message.Body.Text.Data, /20\.50/);
    assert.match(input.Message.Body.Text.Data, /25\.00/);
  } finally {
    sesMock.restore();
  }
});

test('sendBudgetWarningEmail honors GENBI_ALERT_EMAIL override', async () => {
  const sesMock = installSesMock();
  process.env.GENBI_ALERT_EMAIL = 'someone-else@example.com';
  try {
    await sendBudgetWarningEmail({ costSoFar: 22, limit: 25 });
    const input = sesMock.calls[0].input;
    assert.strictEqual(input.Destination.ToAddresses[0], 'someone-else@example.com');
  } finally {
    delete process.env.GENBI_ALERT_EMAIL;
    sesMock.restore();
  }
});
