// One-off script (2026-08-16): Bedrock's "Model access" console page was retired --
// AWS now auto-enables most serverless models on first invoke, but Anthropic models
// still gate behind a one-time use-case form, and some (Claude Sonnet 5 confirmed live)
// return a flat AccessDeniedException pointing at AWS Sales instead of that form. Since
// there's no reliable way to just LIST which models an account can actually invoke
// (the Bedrock catalog lists every model that EXISTS, not which ones this account can
// call), this tries a trivial real invoke against each candidate and reports pass/fail
// directly -- the only way to know for certain.
//
// Usage: node scripts/check-model-access.mjs
//   Requires real AWS credentials. Each successful call costs a fraction of a cent
//   (a few tokens in, a few tokens out) -- negligible, not worth budget-guardrail-gating.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const CANDIDATES = [
  { label: 'Claude Haiku 4.5 (currently live in this app)', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
  { label: 'Claude Sonnet 5 (confirmed denied -- points at AWS Sales)', modelId: 'us.anthropic.claude-sonnet-5' },
  { label: 'Claude Sonnet 4.5', modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
  { label: 'Claude Sonnet 4.6', modelId: 'us.anthropic.claude-sonnet-4-6' },
  { label: 'Claude Opus 5', modelId: 'us.anthropic.claude-opus-5' }
];

const client = new BedrockRuntimeClient({ region: 'us-west-2' });

for (const { label, modelId } of CANDIDATES) {
  process.stdout.write(`${label}\n  modelId: ${modelId}\n  `);
  try {
    const command = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say OK.' }]
      })
    });
    await client.send(command);
    console.log('ACCESS OK\n');
  } catch (err) {
    console.log(`DENIED/ERROR -- ${err.name}: ${err.message}\n`);
  }
}
