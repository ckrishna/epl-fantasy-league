// Test helper: mocks SESClient.prototype.send, same prototype-patching approach as
// mock-bedrock.mjs. Requires @aws-sdk/client-ses to be installed (npm install locally
// -- the sandbox this was authored in has no npm registry access, so this couldn't be
// run there; run `npm test` locally after installing to confirm).
import { mock } from 'node:test';
import { SESClient } from '@aws-sdk/client-ses';

export function installSesMock() {
  const calls = [];
  const handle = mock.method(SESClient.prototype, 'send', async (command) => {
    calls.push(command);
    return { MessageId: 'mock-message-id' };
  });

  return {
    calls,
    restore() {
      handle.mock.restore();
    }
  };
}
