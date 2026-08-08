// Test helper: mocks BedrockRuntimeClient.prototype.send, same prototype-patching
// approach as mock-dynamo.mjs (genbi.mjs dynamically imports BedrockRuntimeClient at
// call time, but patching the shared prototype still affects any instance constructed
// after the patch is installed).
import { mock } from 'node:test';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

export function installBedrockMock(responseText = 'Mock GenBI answer') {
  const handle = mock.method(BedrockRuntimeClient.prototype, 'send', async () => {
    const payload = JSON.stringify({
      content: [{ text: responseText }],
      usage: { input_tokens: 10, output_tokens: 10 }
    });
    return { body: new TextEncoder().encode(payload) };
  });

  return {
    restore() {
      handle.mock.restore();
    }
  };
}
