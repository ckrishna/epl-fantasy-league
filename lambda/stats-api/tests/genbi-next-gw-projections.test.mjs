// EVAL: forward-looking captain/strategy questions -- next_gw_projections context field
// (handlers/genbi.mjs's getNextGwProjections/getFixturesForGW, gated by
// router.mjs's nextGwStrategy keyword group).
//
// Background: every other context field GenBI sends Claude is built from points already
// scored, which is empty (or entirely meaningless pre-season) for "who should I captain
// NEXT gameweek" style questions. This adds a live-fetched projection (FPL's own
// ep_next + price from bootstrap-static, fixture difficulty from our own
// fpl_fixture_data) so those questions get an honest, clearly-labeled-as-a-projection
// answer instead of a decline.

import { test, mock } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock, systemText } from './helpers/mock-bedrock.mjs';
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

function player(overrides = {}) {
  return {
    id: 1,
    web_name: 'Haaland',
    team: 1,
    now_cost: 150,
    ep_next: '8.5',
    status: 'a',
    ...overrides
  };
}

test('a "next gameweek" captain question fetches next_gw_projections, sorted by projected points', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: [buildEvent(1, { is_next: true }), buildEvent(2)],
        teams: [{ id: 1, name: 'Man City' }, { id: 2, name: 'Liverpool' }],
        elements: [
          player({ id: 1, web_name: 'Haaland', team: 1, now_cost: 150, ep_next: '8.5' }),
          player({ id: 2, web_name: 'Salah', team: 2, now_cost: 130, ep_next: '9.2' })
        ]
      }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    fixtures: [{ season_id: 2, event: 1, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 2 }]
  }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: "Who's a good captain pick for next gameweek?" }, {});
    assert.strictEqual(result.statusCode, 200);

    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const proj = JSON.parse(contextBlock.match(/<next_gw_projections>([\s\S]*?)<\/next_gw_projections>/)[1]);

    assert.strictEqual(proj.next_gameweek, 1);
    assert.strictEqual(proj.players.length, 2);
    // Salah has the higher ep_next (9.2 vs 8.5), so should sort first.
    assert.strictEqual(proj.players[0].name, 'Salah');
    assert.strictEqual(proj.players[0].projected_points, 9.2);
    assert.strictEqual(proj.players[0].price, 13);
    assert.strictEqual(proj.players[0].team_name, 'Liverpool');
    assert.deepStrictEqual(proj.players[0].next_fixture, { opponent: 'Man City', is_home: false, difficulty: 2 });

    assert.strictEqual(proj.players[1].name, 'Haaland');
    assert.strictEqual(proj.players[1].price, 15);
    assert.deepStrictEqual(proj.players[1].next_fixture, { opponent: 'Liverpool', is_home: true, difficulty: 3 });
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('unavailable players (status != "a") are excluded from next_gw_projections', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: [buildEvent(1, { is_next: true })],
        teams: [{ id: 1, name: 'Man City' }],
        elements: [
          player({ id: 1, web_name: 'Injured Guy', status: 'i', ep_next: '9.9' }),
          player({ id: 2, web_name: 'Fit Guy', status: 'a', ep_next: '5.0' })
        ]
      }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Good captain pick for next gw?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const proj = JSON.parse(contextBlock.match(/<next_gw_projections>([\s\S]*?)<\/next_gw_projections>/)[1]);

    assert.strictEqual(proj.players.length, 1);
    assert.strictEqual(proj.players[0].name, 'Fit Guy');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

// Regression for the 2026-08-16 silent-failure investigation: a captain question
// declined with "no projection data available" even though bootstrap-static's own
// is_next flag was genuinely set on GW1 at the time -- CloudWatch had nothing to show
// for it, because both early-return branches in getNextGwProjections used to be
// completely silent. These two tests lock in that they now log, so the next occurrence
// is diagnosable instead of a repeat of that investigation.
test('a non-2xx bootstrap-static response logs the status and next_gw_projections stays null', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse({}, { ok: false, status: 429 });
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');
  const errorMock = mock.method(console, 'error', () => {});

  try {
    await handleGenBI({ question: "Who's a good captain pick for next gameweek?" }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const proj = JSON.parse(contextBlock.match(/<next_gw_projections>([\s\S]*?)<\/next_gw_projections>/)[1]);
    assert.strictEqual(proj, null);

    const logged = errorMock.mock.calls.some((c) => String(c.arguments[0]).includes('429'));
    assert.ok(logged, 'Expected the 429 status to be logged instead of failing silently');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
    errorMock.mock.restore();
  }
});

test('no event flagged is_next logs a warning and next_gw_projections stays null', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      // Every event finished, none flagged is_next -- e.g. a concluded season.
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { finished: true })], teams: [], elements: [] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');
  const warnMock = mock.method(console, 'warn', () => {});

  try {
    await handleGenBI({ question: "Who's a good captain pick for next gameweek?" }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const proj = JSON.parse(contextBlock.match(/<next_gw_projections>([\s\S]*?)<\/next_gw_projections>/)[1]);
    assert.strictEqual(proj, null);

    const logged = warnMock.mock.calls.some((c) => String(c.arguments[0]).includes('is_next'));
    assert.ok(logged, 'Expected the missing is_next event to be logged instead of failing silently');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
    warnMock.mock.restore();
  }
});

test('a retrospective captain question (no "next"/"upcoming" wording), current season, does not fetch next_gw_projections', async () => {
  // No `season` param -- stays on the current season, so getActiveGameweek() (inside
  // resolveSeasonContext) legitimately fetches bootstrap-static regardless of this
  // question's wording, same as every other current-season test. What this test
  // actually proves is narrower: that fpl_fixture_data (only ever scanned from inside
  // getNextGwProjections) is never touched, and next_gw_projections stays null.
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { is_next: true })], teams: [], elements: [] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    if (table === 'fpl_fixture_data') {
      throw new Error('Unexpected fpl_fixture_data scan -- a retrospective question does not need next-gw projections');
    }
    return baseDynamoRouter({ fixtures: [] })(command);
  });
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: 'Who captained Haaland this week?' }, {});
    assert.strictEqual(result.statusCode, 200);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const proj = JSON.parse(contextBlock.match(/<next_gw_projections>([\s\S]*?)<\/next_gw_projections>/)[1]);
    assert.strictEqual(proj, null);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('a next-gameweek question about a HISTORICAL season does not fetch next_gw_projections', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      throw new Error('Unexpected bootstrap-static fetch -- next-gw projections have no meaning for a past season');
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    const result = await handleGenBI({ question: "Who's a good captain pick for next gameweek?", season: '2025/26' }, {});
    assert.strictEqual(result.statusCode, 200);
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const proj = JSON.parse(contextBlock.match(/<next_gw_projections>([\s\S]*?)<\/next_gw_projections>/)[1]);
    assert.strictEqual(proj, null);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

// Regression for the 2026-08-16 pre-GW1 investigation: with real, populated
// next_gw_projections data reaching the model, Claude still declined -- reasoning that
// since next_gw_projections.next_gameweek matched <current_gw> (both "1", since no FPL
// event is yet marked is_current or finished this early), it should wait for the
// "current" gameweek to "conclude" before recommending, rather than recognizing that
// next_gameweek == current_gw simply means that gameweek hasn't kicked off yet -- exactly
// when a captain recommendation is needed. Locks in the prompt clarification that closes
// this gap.
test('the system prompt explicitly tells Claude not to withhold a pick when next_gameweek equals current_gw', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { is_next: true })], teams: [], elements: [] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who should I captain next gameweek?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(systemText(payload), /next_gameweek can be the SAME number as <current_gw>/);
    assert.match(systemText(payload), /do not withhold a recommendation/i);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});

test('the system prompt covers next_gw_projections and frames it as a projection, not a fact', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { is_next: true })], teams: [], elements: [] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ fixtures: [] }));
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who should I captain next gameweek?' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(systemText(payload), /<next_gw_projections>/);
    assert.match(systemText(payload), /FORWARD-LOOKING QUESTIONS/);
    assert.match(systemText(payload), /PROJECTION, not a fact/);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
