// EVAL: handleManagerSquad() in handlers/manager-squad.mjs
//
// Powers the "click a manager in Standings" pitch view (tasks #95-101). This handler
// had zero automated coverage before this file -- everything was verified by manually
// running the app locally (task #100) and eyeballing it. Written now because the
// 2026/27 season hasn't kicked off yet (GW1's deadline is still ~9 days out as of
// 2026-08-14, confirmed live via /manager-squad?entry_id=728477 returning
// {"reason":"season_not_started"}), so there's no real picks data to verify the
// squad/player-card rendering path against -- these tests exercise the same code path
// with realistic mock data instead of waiting for the season to start.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic, buildEvent } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { handleManagerSquad } from '../handlers/manager-squad.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const SEASON_ROW = { season_id: 2, season_string: '2026/27', current: true };

// A realistic 15-player squad: 11 starters + 4 bench, matching the shape
// fpl-data-ingester actually writes to fpl_entry_picks.
function buildPicks() {
  const picks = [];
  // Starting XI
  const starters = [
    { player_id: 1, player_name: 'Alisson', player_position: 1, squad_position: 1, player_team: 14, points: 6 },
    { player_id: 2, player_name: 'Trent Alexander-Arnold', player_position: 2, squad_position: 2, player_team: 14, points: 8 },
    { player_id: 3, player_name: 'Virgil van Dijk', player_position: 2, squad_position: 3, player_team: 14, points: 6 },
    { player_id: 4, player_name: 'William Saliba', player_position: 2, squad_position: 4, player_team: 3, points: 2 },
    { player_id: 5, player_name: 'Bukayo Saka', player_position: 3, squad_position: 5, player_team: 3, points: 9, is_captain: true },
    { player_id: 6, player_name: 'Mohamed Salah', player_position: 3, squad_position: 6, player_team: 14, points: 12, is_vice_captain: true },
    { player_id: 7, player_name: 'Kevin De Bruyne', player_position: 3, squad_position: 7, player_team: 43, points: 5 },
    { player_id: 8, player_name: 'Cole Palmer', player_position: 3, squad_position: 8, player_team: 8, points: 3 },
    { player_id: 9, player_name: 'Erling Haaland', player_position: 4, squad_position: 9, player_team: 43, points: 10 },
    { player_id: 10, player_name: 'Ollie Watkins', player_position: 4, squad_position: 10, player_team: 7, points: 2 },
    { player_id: 11, player_name: 'Alexander Isak', player_position: 4, squad_position: 11, player_team: 4, points: 4 }
  ];
  // Bench
  const bench = [
    { player_id: 12, player_name: 'Jordan Pickford', player_position: 1, squad_position: 12, player_team: 11, points: 3, is_bench: true },
    { player_id: 13, player_name: 'Some Defender', player_position: 2, squad_position: 13, player_team: 31, points: 0, is_bench: true },
    { player_id: 14, player_name: 'Some Midfielder', player_position: 3, squad_position: 14, player_team: 54, points: 1, is_bench: true },
    { player_id: 15, player_name: 'Some Forward', player_position: 4, squad_position: 15, player_team: 21, points: 0, is_bench: true }
  ];
  return [...starters, ...bench];
}

function teamsMock() {
  return [
    { season_id: 2, team_id: 14, name: 'Liverpool' },
    { season_id: 2, team_id: 3, name: 'Arsenal' },
    { season_id: 2, team_id: 43, name: 'Man City' },
    { season_id: 2, team_id: 8, name: 'Chelsea' },
    // Aston Villa additionally carries strength/position/points fields (used by the
    // fixture-detail-popup test below) -- every other team in this mock deliberately
    // stays name-only, matching what the other tests actually exercise.
    {
      season_id: 2, team_id: 7, name: 'Aston Villa',
      position: 9, points: 4,
      strength_attack_home: 1180, strength_attack_away: 1120,
      strength_defence_home: 1150, strength_defence_away: 1090
    },
    { season_id: 2, team_id: 4, name: 'Newcastle' },
    { season_id: 2, team_id: 11, name: 'Everton' },
    { season_id: 2, team_id: 31, name: 'Crystal Palace' },
    { season_id: 2, team_id: 54, name: 'Fulham' },
    { season_id: 2, team_id: 21, name: 'West Ham' },
    // 99 deliberately NOT in CLUB_INFO's key set either -- exercises the
    // unrecognized-club fallback path (text badge, no crest).
    { season_id: 2, team_id: 99, name: 'Some Newly Promoted Club' }
  ];
}

function baseDynamoRouter({ picksByGw = {}, formItems = [], fixtures = [], standingsRow = null, activeChip = undefined } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const ctor = command.constructor.name;

    if (table === 'seasons' && ctor === 'ScanCommand') {
      return { Items: [SEASON_ROW] };
    }
    if (table === 'fpl_entry_picks' && ctor === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':k'];
      return { Items: picksByGw[key] || [] };
    }
    if (table === 'teams' && ctor === 'QueryCommand') {
      return { Items: teamsMock() };
    }
    if (table === 'player_event_stats' && ctor === 'QueryCommand') {
      return { Items: formItems };
    }
    if (table === 'fpl_fixture_data' && ctor === 'ScanCommand') {
      return { Items: fixtures };
    }
    if (table === 'fpl_league_standings' && ctor === 'QueryCommand') {
      return { Items: standingsRow ? [standingsRow] : [] };
    }
    // getActiveGameweek() falls back here (via getLatestStoredGameweek) whenever FPL's
    // bootstrap-static has neither a current nor a finished gameweek yet -- the exact
    // true preseason case this test suite is built around. Empty is fine: it just means
    // "nothing stored yet", same as the real preseason state, and getLatestStoredGameweek
    // itself defaults to gameweek 1 when that happens.
    if (table === 'fpl_entry_gameweek' && ctor === 'ScanCommand') {
      return { Items: [] };
    }
    // getActiveChip()'s query -- undefined activeChip means "no row at all" (mirrors a
    // real manager who hasn't played a chip that gameweek, same as the default null the
    // handler falls back to), not merely "chip is null", so tests can distinguish "no
    // data" from "queried, and the answer is no chip".
    if (table === 'fpl_entry_gameweek' && ctor === 'QueryCommand') {
      return { Items: activeChip !== undefined ? [{ active_chip: activeChip }] : [] };
    }
    return undefined;
  };
}

function bootstrapCurrentGw(gw) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({
        events: [buildEvent(gw, { is_current: true })]
      }));
    }
    return null;
  });
}

test('returns full squad with team totals, captain doubling, form tags, and crest/fallback badges', async () => {
  const picks = buildPicks();
  const fetchMock = bootstrapCurrentGw(1);
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    picksByGw: { '2026/27#728477#1': picks },
    formItems: [
      { player_id: 5, form: '8.5' },  // Saka -- hot
      { player_id: 6, form: '1.0' },  // Salah -- cold
      { player_id: 9, form: '4.0' }   // Haaland -- neutral
    ],
    fixtures: [
      { event: 2, team_h: 3, team_a: 14, team_h_name: 'Arsenal', team_a_name: 'Liverpool', team_h_difficulty: 4, team_a_difficulty: 3 }
    ],
    standingsRow: { season_event: '2026/27#1', manager_id: 728477, transfer_cost: 4 }
  }));

  try {
    const response = await handleManagerSquad({ entry_id: '728477' }, CORS);
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);

    assert.strictEqual(body.season, '2026/27');
    assert.strictEqual(body.gameweek, 1);
    assert.strictEqual(body.players.length, 15, 'Expected all 15 picks (11 starters + 4 bench)');

    // Captain doubling: Saka scored 9, is captain -> gw_points should be 18.
    const saka = body.players.find((p) => p.player_id === 5);
    assert.strictEqual(saka.gw_points, 18, 'Captain\'s raw points should be doubled');
    assert.strictEqual(saka.form_tag, 'hot');
    assert.strictEqual(saka.team_code, 'ARS');
    assert.strictEqual(saka.team_crest, '/badges/t3.png');

    // Non-captain: Salah scored 12, not captain -> unchanged.
    const salah = body.players.find((p) => p.player_id === 6);
    assert.strictEqual(salah.gw_points, 12);
    assert.strictEqual(salah.form_tag, 'cold');
    assert.strictEqual(salah.fixtures.length, 1, 'Salah\'s club (Liverpool) has one upcoming fixture in the mock');
    assert.strictEqual(salah.fixtures[0].opponent_code, 'ARS');
    assert.strictEqual(salah.fixtures[0].is_home, false);

    // Player with no form_map entry at all -- form should read null, tag neutral,
    // never crash.
    const trent = body.players.find((p) => p.player_id === 2);
    assert.strictEqual(trent.form, null);
    assert.strictEqual(trent.form_tag, 'neutral');

    // Unrecognized club (not in CLUB_INFO) -- falls back to a text badge, no crest URL.
    const someMidfielder = body.players.find((p) => p.player_id === 14);
    assert.strictEqual(someMidfielder.team_code, 'FUL'); // Fulham IS in CLUB_INFO
    const someForward = body.players.find((p) => p.player_id === 15);
    assert.strictEqual(someForward.team_code, 'WHU'); // West Ham IS in CLUB_INFO

    // Bench flag correctness.
    assert.strictEqual(body.players.filter((p) => p.is_bench).length, 4);
    assert.strictEqual(body.players.filter((p) => !p.is_bench).length, 11);

    // Team totals: gross = sum of STARTERS' (already-doubled) points only.
    // 6+8+6+2+18+12+5+3+10+2+4 = 76
    assert.strictEqual(body.team_gw_points_gross, 76, 'Gross total should sum starters only, with captain already doubled');
    assert.strictEqual(body.transfer_cost, 4);
    assert.strictEqual(body.team_gw_points_net, 72, 'Net = gross minus transfer_cost (76 - 4)');
    assert.strictEqual(body.active_chip, null, 'No chip played this gameweek in this mock');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('Triple Captain triples the captain instead of the normal double', async () => {
  const picks = buildPicks();
  const fetchMock = bootstrapCurrentGw(1);
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    picksByGw: { '2026/27#728477#1': picks },
    standingsRow: { season_event: '2026/27#1', manager_id: 728477, transfer_cost: 0 },
    activeChip: '3xc'
  }));

  try {
    const response = await handleManagerSquad({ entry_id: '728477' }, CORS);
    const body = JSON.parse(response.body);

    assert.strictEqual(body.active_chip, '3xc');
    // Saka (captain) scored 9 -> tripled to 27, not doubled to 18.
    const saka = body.players.find((p) => p.player_id === 5);
    assert.strictEqual(saka.gw_points, 27, 'Triple Captain should triple the captain\'s raw points');
    // Non-captain starters are unaffected -- same 76-total base as the no-chip test,
    // minus Saka's old doubled contribution (18) plus the new tripled one (27).
    assert.strictEqual(body.team_gw_points_gross, 76 - 18 + 27);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('Bench Boost counts the bench toward the team total instead of excluding it', async () => {
  const picks = buildPicks();
  const fetchMock = bootstrapCurrentGw(1);
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    picksByGw: { '2026/27#728477#1': picks },
    standingsRow: { season_event: '2026/27#1', manager_id: 728477, transfer_cost: 0 },
    activeChip: 'bboost'
  }));

  try {
    const response = await handleManagerSquad({ entry_id: '728477' }, CORS);
    const body = JSON.parse(response.body);

    assert.strictEqual(body.active_chip, 'bboost');
    // Bench players from buildPicks(): Pickford 3, defender 0, midfielder 1, forward 0
    // -> +4 on top of the normal 76 starters-only total.
    assert.strictEqual(body.team_gw_points_gross, 76 + 4, 'Bench Boost should add the bench\'s points, not just the starters');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('unrecognized club falls back to a first-3-letters text badge with no crest URL', async () => {
  const fetchMock = bootstrapCurrentGw(1);
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    picksByGw: {
      '2026/27#111#1': [
        { player_id: 1, player_name: 'Mystery Player', player_position: 4, squad_position: 1, player_team: 99, points: 5 }
      ]
    },
    standingsRow: { season_event: '2026/27#1', manager_id: 111, transfer_cost: 0 }
  }));

  try {
    const response = await handleManagerSquad({ entry_id: '111' }, CORS);
    const body = JSON.parse(response.body);
    const player = body.players[0];
    // "Some Newly Promoted Club" -> not in CLUB_INFO -> first 3 letters, uppercased.
    assert.strictEqual(player.team_code, 'SOM');
    assert.strictEqual(player.team_crest, null, 'Unrecognized club should have no crest URL, not a broken image path');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('walks back to the most recent gameweek with real picks when the current one has none yet', async () => {
  const fetchMock = bootstrapCurrentGw(3);
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    picksByGw: {
      // GW3 and GW2 have nothing yet; GW1 does.
      '2026/27#728477#1': [
        { player_id: 1, player_name: 'Alisson', player_position: 1, squad_position: 1, player_team: 14, points: 6 }
      ]
    },
    standingsRow: { season_event: '2026/27#1', manager_id: 728477, transfer_cost: 0 }
  }));

  try {
    const response = await handleManagerSquad({ entry_id: '728477' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.gameweek, 1, 'Should walk back from GW3 -> GW2 -> GW1 and stop at the first one with data');
    assert.strictEqual(body.players.length, 1);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('returns an explicit season_not_started reason (not a false no_data) when nothing exists yet and FPL confirms preseason', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      // Matches live 2026/27 preseason shape: every event not current, not finished.
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { is_current: false, finished: false })] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ picksByGw: {} }));

  try {
    const response = await handleManagerSquad({ entry_id: '728477' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.reason, 'season_not_started');
    assert.deepStrictEqual(body.players, []);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('returns a "no_data" reason (a real gap) when the season has started but this manager has no picks', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [buildEvent(1, { is_current: true, finished: false })] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(baseDynamoRouter({ picksByGw: {} }));

  try {
    const response = await handleManagerSquad({ entry_id: '728477' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.reason, 'no_data', 'Season is live but this manager genuinely has no picks recorded -- a real gap, not preseason');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('fixture-detail popup data: current fixture carries kickoff time, opponent context, and last-5 form oldest-first', async () => {
  const picks = buildPicks();
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    picksByGw: { '2026/27#728477#3': picks },
    fixtures: [
      // Aston Villa's last two results BEFORE gw3 -- used to compute their form
      // "coming into" the gw3 fixture below, oldest (event1) first.
      { event: 1, team_h: 7, team_a: 14, team_h_name: 'Aston Villa', team_a_name: 'Liverpool', team_h_difficulty: 4, team_a_difficulty: 2, status: 'FINISHED', team_h_score: 1, team_a_score: 3 },
      { event: 2, team_h: 4, team_a: 7, team_h_name: 'Newcastle', team_a_name: 'Aston Villa', team_h_difficulty: 3, team_a_difficulty: 3, status: 'FINISHED', team_h_score: 1, team_a_score: 1 },
      // Saka's club (Arsenal, team 3) hosts Aston Villa this gameweek -- not yet played.
      { event: 3, team_h: 3, team_a: 7, team_h_name: 'Arsenal', team_a_name: 'Aston Villa', team_h_difficulty: 3, team_a_difficulty: 3, status: 'PENDING', kickoff_time: '2026-09-01T11:30:00Z' }
    ],
    standingsRow: { season_event: '2026/27#3', manager_id: 728477, transfer_cost: 0 }
  }));

  try {
    // gw passed explicitly -- no bootstrap-static fetch needed to resolve it.
    const response = await handleManagerSquad({ entry_id: '728477', gw: '3' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.gameweek, 3);

    const saka = body.players.find((p) => p.player_id === 5);
    const current = saka.current_fixture;
    assert.ok(current, 'Arsenal has a gw3 fixture, so current_fixture should not be null');
    assert.strictEqual(current.opponent_code, 'AVL');
    assert.strictEqual(current.is_home, true);
    assert.strictEqual(current.status, 'PENDING');
    assert.strictEqual(current.kickoff_time, '2026-09-01T11:30:00Z');
    assert.strictEqual(current.team_h_score, null, 'No score yet on an unplayed fixture');

    const opp = current.opponent;
    assert.ok(opp, 'Opponent context should be populated from the teams table');
    assert.strictEqual(opp.name, 'Aston Villa');
    assert.strictEqual(opp.position, 9);
    assert.strictEqual(opp.points, 4);
    // Arsenal is home, so Aston Villa are playing AWAY -- their AWAY strength numbers
    // are the correct venue-side figures for this fixture, not their home ones.
    assert.strictEqual(opp.strength_attack, 1120);
    assert.strictEqual(opp.strength_defence, 1090);
    // Oldest first: event1 (Villa lost 1-3) then event2 (Villa drew 1-1) -- most
    // recent result is last in the array, not first.
    assert.deepStrictEqual(opp.form, ['L', 'D']);
  } finally {
    dynamoMock.restore();
  }
});

test('missing entry_id returns 400 without touching the database', async () => {
  const dynamoMock = installDynamoMock(() => {
    throw new Error('Should not query DynamoDB when entry_id is missing');
  });

  try {
    const response = await handleManagerSquad({}, CORS);
    assert.strictEqual(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.match(body.error, /entry_id/);
  } finally {
    dynamoMock.restore();
  }
});
