// EVAL: multi-gameweek fixture lookahead -- fixture_run context field (handlers/genbi.mjs's
// getFixtureRun, gated by router.mjs's fixtureRun keyword group). GH #46 gap 1.
//
// Background: next_gw_projections (see genbi-next-gw-projections.test.mjs) already covers
// a single upcoming gameweek at player granularity. This adds a separate, TEAM-level view
// across several upcoming gameweeks (FPL's own 1-5 fixture-difficulty rating, no live
// projection involved) for "who has a good run of fixtures coming up" / chip-timing-adjacent
// questions -- see scripts/issue-comments/comment-46-fixture-lookahead-chip-state.md.

import { test, mock } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildEvent } from './helpers/mock-fetch.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

function baseDynamoRouter({ fixtures = [] } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;

    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      if (command.input.FilterExpression) {
        return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
      }
      return { Items: [{ season_id: 1, season_string: '2025/26' }, { season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_season_totals' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_fixture_data' && type === 'ScanCommand') return { Items: fixtures };
    return undefined;
  };
}

test('a "good fixtures coming up" question fetches fixture_run, sorted easiest first', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: [buildEvent(1, { is_next: true }), buildEvent(2), buildEvent(3), buildEvent(4), buildEvent(5)],
        teams: [{ id: 1, name: 'Man City' }, { id: 2, name: 'Liverpool' }, { id: 3, name: 'Burnley' }]
      }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    fixtures: [
      // Man City (1): easy run, avg difficulty 2
      { season_id: 2, event: 1, team_h: 1, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 4 },
      { season_id: 2, event: 2, team_h: 3, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 2 },
      // Liverpool (2): tough run, avg difficulty 4.5
      { season_id: 2, event: 1, team_h: 2, team_a: 3, team_h_difficulty: 5, team_a_difficulty: 1 },
      { season_id: 2, event: 2, team_h: 3, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }
    ]
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Who has good fixtures coming up?' }, {});
    assert.strictEqual(result.statusCode, 200);

    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const run = JSON.parse(contextBlock.match(/<fixture_run>([\s\S]*?)<\/fixture_run>/)[1]);

    assert.strictEqual(run.from_gameweek, 1);
    assert.strictEqual(run.to_gameweek, 5);
    // Man City (avg 2.5) should sort ahead of Liverpool (avg... note team_a fixtures
    // also feed Burnley, but we only assert City vs Liverpool ordering here).
    const city = run.teams.find((t) => t.team_name === 'Man City');
    const liverpool = run.teams.find((t) => t.team_name === 'Liverpool');
    assert.ok(city, 'Expected Man City in fixture_run.teams');
    assert.ok(liverpool, 'Expected Liverpool in fixture_run.teams');
    const cityIdx = run.teams.indexOf(city);
    const liverpoolIdx = run.teams.indexOf(liverpool);
    assert.ok(cityIdx < liverpoolIdx, 'Expected the easier-average-difficulty team to sort first');
    assert.strictEqual(city.fixture_count, 2);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('a fixture-run question about a HISTORICAL season does not fetch fixture_run', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      throw new Error('Unexpected bootstrap-static fetch -- fixture lookahead has no meaning for a past season');
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Who has good fixtures coming up?', season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const run = JSON.parse(contextBlock.match(/<fixture_run>([\s\S]*?)<\/fixture_run>/)[1]);
    assert.strictEqual(run, null);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('a retrospective captain question, current season, does not fetch fixture_run', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { is_next: true })], teams: [], elements: [] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'fpl_fixture_data') {
      throw new Error('Unexpected fpl_fixture_data scan -- a retrospective question does not need fixture_run');
    }
    return baseDynamoRouter({ fixtures: [] })(command);
  });
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Who captained Haaland this week?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const run = JSON.parse(contextBlock.match(/<fixture_run>([\s\S]*?)<\/fixture_run>/)[1]);
    assert.strictEqual(run, null);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

// Same silent-failure regression pattern established in genbi-next-gw-projections.test.mjs
// for getNextGwProjections -- getFixtureRun shares the same two early-return branches, so
// lock in that they log instead of failing silently.
test('a non-2xx bootstrap-static response logs the status and fixture_run stays null', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse({}, { ok: false, status: 503 });
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');
  const errorMock = mock.method(console, 'error', () => {});

  try {
    await handleGenBI({ question: 'Who has good fixtures coming up?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const run = JSON.parse(contextBlock.match(/<fixture_run>([\s\S]*?)<\/fixture_run>/)[1]);
    assert.strictEqual(run, null);

    const logged = errorMock.mock.calls.some((c) => String(c.arguments[0]).includes('503'));
    assert.ok(logged, 'Expected the 503 status to be logged instead of failing silently');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
    errorMock.mock.restore();
  }
});

test('no event flagged is_next logs a warning and fixture_run stays null', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { finished: true })], teams: [], elements: [] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');
  const warnMock = mock.method(console, 'warn', () => {});

  try {
    await handleGenBI({ question: 'Who has good fixtures coming up?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    const run = JSON.parse(contextBlock.match(/<fixture_run>([\s\S]*?)<\/fixture_run>/)[1]);
    assert.strictEqual(run, null);

    const logged = warnMock.mock.calls.some((c) => String(c.arguments[0]).includes('is_next'));
    assert.ok(logged, 'Expected the missing is_next event to be logged instead of failing silently');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
    warnMock.mock.restore();
  }
});

// Regression for the 2026-08-16 GenBI latency investigation: a "good fixtures coming
// up" question matches fixtureRun, which router.mjs forces nextGwStrategy on for too
// (see its own comment) -- so both getNextGwProjections and getFixtureRun used to run,
// and each independently fetched bootstrap-static, hitting FPL's live API 3 times in
// this one request (getActiveGameweek in dynamodb.mjs makes its own separate call to
// resolve the current gameweek before the router even runs, PLUS the two genbi.mjs-local
// calls this test targets). fetchBootstrapAndNextEvent in genbi.mjs now shares one fetch
// between the latter two, bringing this down to 2 -- getActiveGameweek's own call is
// shared infrastructure used by every other handler (standings, winners, trends...), not
// just GenBI, so deduping THAT one is a separate, larger-blast-radius change, deliberately
// left alone here (flagged as a further optimization opportunity, not fixed in this pass).
test('a question needing both fixture_run and next_gw_projections fetches bootstrap-static only twice (not 3x)', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: [buildEvent(1, { is_next: true })],
        teams: [{ id: 1, name: 'Man City' }],
        elements: []
      }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Who has good fixtures coming up?' }, {});
    assert.strictEqual(result.statusCode, 200);

    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = payload.system.match(/<context>([\s\S]*?)<\/context>/)[1];
    // Confirms next_gw_projections really was fetched too (not just fixture_run) --
    // otherwise a single bootstrap-static call wouldn't actually prove dedup, just that
    // only one field was requested.
    assert.match(contextBlock, /<next_gw_projections>/);
    assert.match(contextBlock, /<fixture_run>/);

    const bootstrapCalls = fetchMock.calls.filter((c) => c.url.includes('bootstrap-static'));
    assert.strictEqual(bootstrapCalls.length, 2,
      `Expected exactly two bootstrap-static fetches (getActiveGameweek's own call, plus one ` +
      `shared call for next_gw_projections+fixture_run combined -- down from 3 before this fix), ` +
      `got ${bootstrapCalls.length}`);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('the system prompt covers fixture_run and distinguishes it from next_gw_projections', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { is_next: true })], teams: [], elements: [] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who has good fixtures coming up?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(payload.system, /<fixture_run>/);
    assert.match(payload.system, /FIXTURE RUNS \(GH #46 gap 1\)/);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
