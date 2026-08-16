// Test helper: mocks BedrockRuntimeClient.prototype.send, same prototype-patching
// approach as mock-dynamo.mjs (genbi.mjs dynamically imports BedrockRuntimeClient at
// call time, but patching the shared prototype still affects any instance constructed
// after the patch is installed).
import { mock } from 'node:test';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

export function installBedrockMock(responseText = 'Mock GenBI answer', { inputTokens = 10, outputTokens = 10 } = {}) {
  const calls = [];
  const handle = mock.method(BedrockRuntimeClient.prototype, 'send', async (command) => {
    calls.push(command);
    const payload = JSON.stringify({
      content: [{ text: responseText }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    return { body: new TextEncoder().encode(payload) };
  });

  return {
    calls,
    restore() {
      handle.mock.restore();
    }
  };
}

// bedrock.mjs's askClaude sends `system` as an array of content blocks (a static,
// cacheable block plus a per-request dynamic one -- see STATIC_SYSTEM_PROMPT's comment
// in bedrock.mjs for why: Bedrock prompt caching requires an array shape, cache_control
// can only attach to an individual block, not a plain string). Tests written before that
// change did `payload.system.match(...)`/`.includes(...)` against a plain string --
// this reconstructs that same flat string from the array shape so every existing
// assertion (which only ever cares about the concatenated TEXT, never which block a
// given tag lives in) keeps working unchanged.
export function systemText(payload) {
  return Array.isArray(payload.system)
    ? payload.system.map((block) => block.text).join('\n')
    : payload.system;
}

// Extracts just the <context>...</context> block's inner text. Needed (not just a
// convenience) for tests that then regex-match a SPECIFIC tag name inside it (e.g.
// <season_totals>, <player_data>) -- the static instructions block now sits BEFORE
// <context> in the prompt (see STATIC_SYSTEM_PROMPT's comment in bedrock.mjs) and its
// own <definitions_2> section refers to those exact tag names in plain prose (e.g. "-
// <season_totals>: each player's points SUMMED..."), with no closing tag anywhere
// nearby. A non-greedy `<season_totals>(.*?)<\/season_totals>` run against the FULL
// system text would match from that prose mention all the way to the real closing tag
// deep inside <context>, capturing everything in between as garbage instead of the
// actual JSON. Scoping the search to the extracted <context> block first (which cannot
// contain another <context> tag) avoids that collision entirely.
export function systemContextBlock(payload) {
  return systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
}
