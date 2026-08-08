// EVAL: handleGenBI() reports how long the Bedrock call actually took, alongside the
// token usage it already reports -- requested so the frontend can show response time
// next to the existing "Tokens: N" display.
import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildPostSeasonEvents } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

test('[current bug] response includes duration_ms for the Bedrock call', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: buildPostSeasonEvents(38) }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      return { Items: [{ season_id: 1, season_string: '2025/26', current: true }] };
    }
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    return undefined;
  });
  const bedrockMock = installBedrockMock();

  try {
    const result = await handleGenBI({ question: 'Who is winning?' }, {});
    const body = JSON.parse(result.body);
    assert.strictEqual(typeof body.duration_ms, 'number',
      `Expected duration_ms to be a number, got ${typeof body.duration_ms}`);
    assert.ok(body.duration_ms >= 0, 'duration_ms should be non-negative');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
