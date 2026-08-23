// Test helper: install/restore a mock for DynamoDBDocumentClient.prototype.send so we
// can unit test lambda handlers without hitting real AWS. Works by patching the shared
// prototype method (confirmed via probe: `send` is inherited, not an own property, so
// every DynamoDBDocumentClient instance in the module under test picks up the mock).
//
// Usage:
//   const dynamoMock = installDynamoMock((command) => {
//     const table = command.input.TableName;
//     if (table === 'seasons' && command.constructor.name === 'ScanCommand') {
//       return { Items: [{ season_id: '2025/26', current: true }] };
//     }
//     return undefined; // unmatched -> throws, surfaces test bugs instead of silently passing
//   });
//   ... run code under test ...
//   dynamoMock.restore();

import { mock } from 'node:test';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export function installDynamoMock(router) {
  const calls = [];

  const handle = mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    calls.push(command);
    const result = await router(command);
    if (result === undefined) {
      throw new Error(
        `[mock-dynamo] No mock route matched for ${command.constructor.name} on table "${command.input?.TableName}". ` +
        `Input: ${JSON.stringify(command.input)}`
      );
    }
    return result;
  });

  return {
    calls,
    restore() {
      handle.mock.restore();
    }
  };
}

// Mimics DynamoDB's FilterExpression for the one pattern our lambdas actually use:
// "<attr> = :value". Returns items where item[attr] === value. If no FilterExpression
// is present (as in the pre-fix buggy code), returns all items unfiltered -- which is
// exactly the bug we want the eval to be able to observe.
export function applyEqualityFilter(items, command, attrName) {
  const fe = command.input.FilterExpression;
  const ean = command.input.ExpressionAttributeNames || {};
  const eav = command.input.ExpressionAttributeValues || {};
  if (!fe) return items;

  // Resolve the placeholder name (e.g. "#c") back to the real attribute name if aliased.
  const resolvedAttr = Object.entries(ean).find(([, v]) => v === attrName)?.[0];
  const attrToken = resolvedAttr || attrName;
  if (!fe.includes(attrToken)) return items;

  const valueToken = Object.keys(eav).find((k) => fe.includes(k));
  if (!valueToken) return items;

  const expected = eav[valueToken];
  return items.filter((item) => item[attrName] === expected);
}
