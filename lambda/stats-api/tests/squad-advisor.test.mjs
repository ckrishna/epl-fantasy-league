// EVAL: suggestTransfer() and handleSquadAdvisor() in handlers/manager-squad.mjs
//
// GH #44's first real (non-mock) advisor piece -- a single transfer suggestion, scoped
// to exactly what the user asked for when "advancing the advisor feature to completion"
// (real transfer suggestion only, sourced from the FULL ~700-player FPL pool, not just
// the manager's own bench). Captain/fixture-outlook stay hand-written mock content in
// ManagerSquad.jsx -- out of scope for this file.
//
// Split into two halves: suggestTransfer is pure (no I/O), so it's tested directly
// against hand-built picks/pool fixtures with no mock-fetch/mock-dynamo scaffolding at
// all. handleSquadAdvisor wraps it with real DynamoDB/fetch calls, so those tests reuse
// this repo's existing mock-fetch/mock-dynamo helpers, same conventions as
// manager-squad-handler.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import { installFetchMock, jsonResponse, buildBootstrapStatic } from './helpers/mock-fetch.mjs';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import {
  suggestTransfer, handleSquadAdvisor, getFixtureRunMap, getUpcomingChipWindows,
  evaluateBenchBoost, evaluateTripleCaptain, evaluateFreeHit, evaluateWildcard, evaluateChipOptions
} from '../handlers/manager-squad.mjs';
import { handler } from '../index.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const SEASON_ROW = { season_id: 2, season_string: '2026/27', current: true };

// ---- suggestTransfer (pure) ----

function pick(id, position) {
  return { player_id: id, player_position: position };
}

function poolPlayer(id, overrides = {}) {
  return {
    id,
    web_name: `Player${id}`,
    team: 1,
    element_type: 3,
    now_cost: 80,
    form: '4.0',
    selected_by_percent: '10.0',
    ep_next: '4.0',
    status: 'a',
    ...overrides
  };
}

function poolFrom(players) {
  const map = new Map();
  for (const p of players) map.set(p.id, p);
  return map;
}

test('suggestTransfer: empty picks returns no_data without touching the pool', () => {
  const result = suggestTransfer([], poolFrom([poolPlayer(1)]), 0);
  assert.deepStrictEqual(result, { found: false, reason: 'no_data' });
});

test('suggestTransfer: empty pool returns no_data', () => {
  const result = suggestTransfer([pick(1, 3)], new Map(), 0);
  assert.deepStrictEqual(result, { found: false, reason: 'no_data' });
});

test('suggestTransfer: among all-available players, the coldest form is picked as the OUT candidate', () => {
  const picks = [pick(1, 3), pick(2, 3), pick(3, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '8.0' }),
    poolPlayer(2, { form: '1.5' }), // coldest -- should be the OUT candidate
    poolPlayer(3, { form: '5.0' }),
    poolPlayer(99, { id: 99, form: '9.0', now_cost: 80 }) // affordable replacement
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.out.player_id, 2, 'The coldest-form available player should be flagged OUT');
});

test('suggestTransfer: availability trumps form -- an unavailable player is picked OUT even over a colder-but-available teammate', () => {
  const picks = [pick(1, 3), pick(2, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '0.5', status: 'a' }),   // very cold but available
    poolPlayer(2, { form: '9.0', status: 'i' }),   // hot form, but injured
    poolPlayer(99, { id: 99, form: '5.0', now_cost: 80 })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.out.player_id, 2, 'Injured status should outweigh hot form entirely');
  assert.strictEqual(result.out.availability_status, 'i');
  assert.match(result.reason, /is injured/);
});

test('suggestTransfer: replacement candidates are constrained to the outgoing player\'s own position', () => {
  const picks = [pick(1, 4)]; // FWD
  const pool = poolFrom([
    poolPlayer(1, { element_type: 4, form: '2.0', now_cost: 80 }),
    poolPlayer(2, { element_type: 4, form: '9.0', now_cost: 80 }), // correct position -- eligible
    poolPlayer(3, { element_type: 3, form: '9.9', now_cost: 80 })  // MID -- wrong position, must be excluded
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 2, 'A MID candidate should never be suggested to replace a FWD');
});

test('suggestTransfer: a candidate above the budget ceiling (out price + bank) is excluded', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { now_cost: 80, form: '2.0' }),   // £8.0m outgoing
    poolPlayer(2, { now_cost: 95, form: '9.0' }),   // £9.5m -- too expensive with 0 bank
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.reason, 'no_affordable_upgrade');
  assert.strictEqual(result.out.player_id, 1);
});

test('suggestTransfer: bank is added to the budget ceiling, making an otherwise-unaffordable candidate valid', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { now_cost: 80, form: '2.0' }),  // £8.0m outgoing
    poolPlayer(2, { now_cost: 95, form: '9.0' }),  // £9.5m -- needs 15 tenths of bank
  ]);
  const result = suggestTransfer(picks, pool, 20); // £2.0m in the bank
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 2);
  assert.strictEqual(result.in.price, 9.5);
});

test('suggestTransfer: already-owned players are never suggested as the replacement', () => {
  const picks = [pick(1, 3), pick(2, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { form: '9.9', now_cost: 80 }), // best-scoring candidate, but already owned
    poolPlayer(3, { form: '5.0', now_cost: 80 })  // should win instead
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 3, 'Player 2 is already on the squad and must be excluded from candidates');
});

test('suggestTransfer: unavailable pool candidates are never suggested as the replacement', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { form: '9.9', now_cost: 80, status: 'd' }), // best score, but doubtful
    poolPlayer(3, { form: '5.0', now_cost: 80, status: 'a' })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 3);
});

test('suggestTransfer: candidate ranking favors higher ep_next (weighted x2) plus form', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { ep_next: '3.0', form: '9.0', now_cost: 80 }),  // score = 6 + 9 = 15
    poolPlayer(3, { ep_next: '8.0', form: '0.0', now_cost: 80 })   // score = 16 + 0 = 16 -- should win
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.in.player_id, 3, 'ep_next is weighted x2, so it should outrank a pure-form candidate here');
});

test('suggestTransfer: a picks/pool mismatch (stale player_id not in the pool) is skipped rather than crashing', () => {
  const picks = [pick(999, 3), pick(2, 3)]; // 999 not in pool at all
  const pool = poolFrom([
    poolPlayer(2, { form: '3.0', now_cost: 80 }),
    poolPlayer(99, { id: 99, form: '9.0', now_cost: 80 })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.out.player_id, 2, 'Player 999 has no pool entry and must be skipped, not crash the whole function');
});

test('suggestTransfer: when every owned player is missing from the pool, returns no_data instead of crashing', () => {
  const picks = [pick(999, 3), pick(998, 3)];
  const pool = poolFrom([poolPlayer(2, { form: '9.0', now_cost: 80 })]);
  const result = suggestTransfer(picks, pool, 0);
  assert.deepStrictEqual(result, { found: false, reason: 'no_data' });
});

test('suggestTransfer: delta_pts and reason reflect the actual ep_next gap and both player names', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80, ep_next: '3.0' }),
    poolPlayer(2, { form: '9.0', now_cost: 80, ep_next: '5.5' })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.delta_pts, 2.5);
  assert.match(result.reason, /Player1/);
  assert.match(result.reason, /Player2/);
  assert.match(result.reason, /has cooled off/, 'An available-but-cold OUT candidate should use the form-based reason phrasing, not an availability one');
});

test('suggestTransfer: underlying-quality bonus (xgi_per_90 + ict_index) can outrank a raw ep_next/form edge', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    // Slightly better ep_next/form, but no underlying-quality signal at all.
    poolPlayer(2, { ep_next: '4.0', form: '4.5', now_cost: 80, xgi_per_90: '0.0', ict_index: '0' }),
    // Slightly worse ep_next/form, but strong xGI/ICT should push it ahead.
    poolPlayer(3, { ep_next: '4.0', form: '4.0', now_cost: 80, xgi_per_90: '0.9', ict_index: '200' })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.in.player_id, 3, 'Higher xgi_per_90/ict_index should tip the ranking despite a slightly lower raw ep_next+form');
});

test('suggestTransfer: differential bonus favors a lower-owned player when other scoring inputs are equal', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { ep_next: '4.0', form: '4.0', now_cost: 80, selected_by_percent: '60.0' }),
    poolPlayer(3, { ep_next: '4.0', form: '4.0', now_cost: 80, selected_by_percent: '2.0' })
  ]);
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.in.player_id, 3, 'Everything else equal, the lower-owned differential should be preferred');
});

test('suggestTransfer: fixtureRunMap rewards a candidate whose team has an easier upcoming run', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { ep_next: '4.0', form: '4.0', now_cost: 80, team: 10 }), // hard run below
    poolPlayer(3, { ep_next: '4.0', form: '4.0', now_cost: 80, team: 20 })  // easy run below
  ]);
  const fixtureRunMap = new Map([
    [10, 5], // avg difficulty 5 -- hardest possible, negative bonus
    [20, 1]  // avg difficulty 1 -- easiest possible, positive bonus
  ]);
  const result = suggestTransfer(picks, pool, 0, fixtureRunMap);
  assert.strictEqual(result.in.player_id, 3, 'A team with an easier average fixture difficulty should be favored when everything else ties');
});

test('suggestTransfer: an omitted fixtureRunMap defaults to no fixture-run bonus at all (backward compatible)', () => {
  const picks = [pick(1, 3)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', now_cost: 80 }),
    poolPlayer(2, { ep_next: '5.0', form: '5.0', now_cost: 80 })
  ]);
  // Calling with the old 3-arg signature should behave exactly as before.
  const result = suggestTransfer(picks, pool, 0);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.in.player_id, 2);
});

// ---- getFixtureRunMap (pure) ----

function fixture(event, teamH, teamA, diffH, diffA) {
  return { event, team_h: teamH, team_a: teamA, team_h_difficulty: diffH, team_a_difficulty: diffA };
}

test('getFixtureRunMap: averages a team\'s difficulty across home and away fixtures within the window', () => {
  const fixtures = [
    fixture(5, 1, 2, 2, 4),  // team 1 home @ diff 2, team 2 away @ diff 4
    fixture(6, 3, 1, 5, 2),  // team 1 away @ diff 2, team 3 home @ diff 5
  ];
  const map = getFixtureRunMap(fixtures, 5, 4);
  assert.strictEqual(map.get(1), 2, 'Team 1 played twice, both at difficulty 2 -- average should be 2');
  assert.strictEqual(map.get(2), 4);
  assert.strictEqual(map.get(3), 5);
});

test('getFixtureRunMap: fixtures outside the [fromGw, fromGw+numGws-1] window are excluded', () => {
  const fixtures = [
    fixture(4, 1, 2, 1, 1),  // before the window
    fixture(5, 1, 2, 3, 3),  // in window
    fixture(9, 1, 2, 5, 5),  // after a 4-gw window starting at 5 (5,6,7,8)
  ];
  const map = getFixtureRunMap(fixtures, 5, 4);
  assert.strictEqual(map.get(1), 3, 'Only the gw-5 fixture should count toward the average');
});

test('getFixtureRunMap: a team with no fixtures in the window (blank gameweek) is simply absent from the map', () => {
  const fixtures = [fixture(5, 1, 2, 3, 3)];
  const map = getFixtureRunMap(fixtures, 6, 4); // window starts after this fixture
  assert.strictEqual(map.has(1), false);
  assert.strictEqual(map.has(2), false);
});

test('getFixtureRunMap: an empty or missing fixtures array returns an empty map rather than throwing', () => {
  assert.strictEqual(getFixtureRunMap([], 1, 4).size, 0);
  assert.strictEqual(getFixtureRunMap(undefined, 1, 4).size, 0);
});

// ---- getUpcomingChipWindows (pure) ----

test('getUpcomingChipWindows: flags a team with zero fixtures in a gameweek as a blank', () => {
  // Three teams total (1, 2, 3); only 1 & 2 play in gw 5 -- team 3 blanks.
  const fixtures = [
    fixture(4, 1, 3, 2, 2),  // establishes team 3 exists, played in gw 4
    fixture(5, 1, 2, 2, 2),
  ];
  const windows = getUpcomingChipWindows(fixtures, 5, 1);
  const gw5 = windows.find((w) => w.gameweek === 5);
  assert.ok(gw5, 'gw5 should be flagged since team 3 has no fixture that week');
  assert.deepStrictEqual(gw5.blank_teams, [3]);
  assert.deepStrictEqual(gw5.double_teams, []);
});

test('getUpcomingChipWindows: flags a team playing twice in one gameweek as a double', () => {
  const fixtures = [
    fixture(5, 1, 2, 2, 2),
    fixture(5, 1, 3, 3, 3), // team 1 plays twice in gw 5
  ];
  const windows = getUpcomingChipWindows(fixtures, 5, 1);
  const gw5 = windows.find((w) => w.gameweek === 5);
  assert.ok(gw5);
  assert.deepStrictEqual(gw5.double_teams, [1]);
});

test('getUpcomingChipWindows: a gameweek where every known team plays exactly once is omitted entirely', () => {
  const fixtures = [
    fixture(4, 1, 2, 2, 2), // establishes teams 1 & 2
    fixture(5, 1, 2, 3, 3), // both play exactly once in gw5 -- nothing to flag
  ];
  const windows = getUpcomingChipWindows(fixtures, 5, 1);
  assert.strictEqual(windows.find((w) => w.gameweek === 5), undefined);
});

test('getUpcomingChipWindows: an empty or missing fixtures array returns an empty array rather than throwing', () => {
  assert.deepStrictEqual(getUpcomingChipWindows([], 1, 5), []);
  assert.deepStrictEqual(getUpcomingChipWindows(undefined, 1, 5), []);
});

// ---- evaluateBenchBoost (pure) ----

function benchPick(id, name, team = 1) {
  return { player_id: id, player_name: name, squad_position: 11 + id, player_team: team }; // > 11 -> bench
}

function starterPick(id, name, team = 1) {
  return { player_id: id, player_name: name, squad_position: id, player_team: team }; // <= 11 -> starter
}

test('evaluateBenchBoost: returns null when there are no bench players at all (squad_position <= 11 for everyone)', () => {
  const picks = [starterPick(1, 'Starter One')];
  const result = evaluateBenchBoost(picks, poolFrom([poolPlayer(1)]), new Map());
  assert.strictEqual(result, null);
});

test('evaluateBenchBoost: recommends Bench Boost when most of the bench is available and playing this week', () => {
  const picks = [1, 2, 3, 4].map((id) => benchPick(id, `Bench${id}`, id));
  const pool = poolFrom(picks.map((p) => poolPlayer(p.player_id, { status: 'a' })));
  // Teams 1-3 have a fixture this week (difficulty 2, favorable); team 4 blanks.
  const fixtureThisGwMap = new Map([[1, 2], [2, 2], [3, 2]]);
  const result = evaluateBenchBoost(picks, pool, fixtureThisGwMap);
  assert.strictEqual(result.recommended, true, '3 of 4 (75%) contributing should clear the recommend bar');
  assert.strictEqual(result.contributing_count, 3);
  assert.strictEqual(result.bench_total, 4);
  assert.match(result.reason, /Bench1/);
  assert.match(result.reason, /Bench2/);
  assert.match(result.reason, /Bench3/);
  assert.doesNotMatch(result.reason, /Bench4/, 'Bench4 blanks this week and should not be named among the contributors');
});

test('evaluateBenchBoost: does not recommend when only a minority of the bench is available/playing', () => {
  const picks = [1, 2, 3, 4].map((id) => benchPick(id, `Bench${id}`, id));
  const pool = poolFrom(picks.map((p) => poolPlayer(p.player_id, { status: 'a' })));
  const fixtureThisGwMap = new Map([[1, 2]]); // only team 1 plays this week
  const result = evaluateBenchBoost(picks, pool, fixtureThisGwMap);
  assert.strictEqual(result.recommended, false);
  assert.strictEqual(result.contributing_count, 1);
  assert.match(result.reason, /Only 1 of your 4 bench players/);
});

test('evaluateBenchBoost: an unavailable (injured/suspended) bench player never counts as contributing, even with a fixture', () => {
  const picks = [1, 2, 3, 4].map((id) => benchPick(id, `Bench${id}`, id));
  const pool = poolFrom([
    poolPlayer(1, { status: 'i' }), // injured, has a fixture -- still shouldn't count
    poolPlayer(2, { status: 'a' }),
    poolPlayer(3, { status: 'a' }),
    poolPlayer(4, { status: 'a' })
  ]);
  const fixtureThisGwMap = new Map([[1, 2], [2, 2], [3, 2], [4, 2]]);
  const result = evaluateBenchBoost(picks, pool, fixtureThisGwMap);
  assert.strictEqual(result.contributing_count, 3, 'The injured player should be excluded from the contributing count despite having a fixture');
});

test('evaluateBenchBoost: nobody available/playing produces the "none" reason and recommended:false', () => {
  const picks = [1, 2].map((id) => benchPick(id, `Bench${id}`, id));
  const pool = poolFrom(picks.map((p) => poolPlayer(p.player_id, { status: 'i' })));
  const result = evaluateBenchBoost(picks, pool, new Map());
  assert.strictEqual(result.recommended, false);
  assert.strictEqual(result.contributing_count, 0);
  assert.match(result.reason, /None of your bench/);
  assert.match(result.reason, /Bench1/, 'The "none" reason should still name every bench player, not just contributors');
});

test('evaluateBenchBoost: an omitted fixtureThisGwMap defaults to nobody playing (backward compatible, never crashes)', () => {
  const picks = [benchPick(1, 'Bench1', 1)];
  const pool = poolFrom([poolPlayer(1, { status: 'a' })]);
  const result = evaluateBenchBoost(picks, pool);
  assert.strictEqual(result.contributing_count, 0, 'No fixture data means nothing counts as "playing" this week');
});

test('evaluateBenchBoost: a bench player missing from the live pool is treated as unavailable rather than crashing', () => {
  const picks = [benchPick(1, 'GhostPlayer', 1)];
  const result = evaluateBenchBoost(picks, new Map(), new Map([[1, 2]]));
  assert.strictEqual(result.contributing_count, 0);
  assert.strictEqual(result.bench[0].available, false);
});

// ---- evaluateTripleCaptain (pure) ----

test('evaluateTripleCaptain: recommends the best-scoring available starter when the score clears the bar', () => {
  const picks = [starterPick(1, 'Weak', 1), starterPick(2, 'Elite', 2)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', ep_next: '2.0' }),
    poolPlayer(2, { form: '9.0', ep_next: '9.0', xgi_per_90: '0.8', ict_index: '250' })
  ]);
  const result = evaluateTripleCaptain(picks, pool);
  assert.strictEqual(result.player.player_id, 2);
  assert.strictEqual(result.recommended, true);
  assert.match(result.reason, /Elite/);
});

test('evaluateTripleCaptain: does not recommend when even the best starter is unremarkable', () => {
  const picks = [starterPick(1, 'Mediocre', 1)];
  const pool = poolFrom([poolPlayer(1, { form: '2.0', ep_next: '2.0' })]);
  const result = evaluateTripleCaptain(picks, pool);
  assert.strictEqual(result.recommended, false);
});

test('evaluateTripleCaptain: bench players are never considered, even with a great score', () => {
  const picks = [starterPick(1, 'Starter', 1), benchPick(2, 'BenchStar', 2)];
  const pool = poolFrom([
    poolPlayer(1, { form: '2.0', ep_next: '2.0' }),
    poolPlayer(2, { form: '9.9', ep_next: '9.9' })
  ]);
  const result = evaluateTripleCaptain(picks, pool);
  assert.strictEqual(result.player.player_id, 1, 'Only starters (squad_position <= 11) should ever be considered for the armband');
});

test('evaluateTripleCaptain: an unavailable starter is skipped even if their raw stats look great', () => {
  const picks = [starterPick(1, 'Injured', 1)];
  const pool = poolFrom([poolPlayer(1, { form: '9.9', ep_next: '9.9', status: 'i' })]);
  const result = evaluateTripleCaptain(picks, pool);
  assert.strictEqual(result, null, 'No available starter exists in the pool, so there is nothing to recommend');
});

// ---- evaluateFreeHit (pure) ----

test('evaluateFreeHit: recommends Free Hit when a large share of the starting XI blanks this week', () => {
  const picks = [1, 2, 3].map((id) => starterPick(id, `Starter${id}`, id));
  const fixtureThisGwMap = new Map([[1, 2]]); // only team 1 plays -- teams 2 & 3 blank
  const result = evaluateFreeHit(picks, fixtureThisGwMap);
  assert.strictEqual(result.blank_count, 2);
  assert.strictEqual(result.recommended, true);
  assert.match(result.reason, /Starter2/);
  assert.match(result.reason, /Starter3/);
});

test('evaluateFreeHit: does not recommend when only a small minority of the starting XI blanks', () => {
  const picks = [1, 2, 3, 4, 5].map((id) => starterPick(id, `Starter${id}`, id));
  const fixtureThisGwMap = new Map([[1, 2], [2, 2], [3, 2], [4, 2]]); // only team 5 blanks
  const result = evaluateFreeHit(picks, fixtureThisGwMap);
  assert.strictEqual(result.recommended, false);
});

test('evaluateFreeHit: nobody blanking returns a clean "no reason" result', () => {
  const picks = [starterPick(1, 'Starter1', 1)];
  const fixtureThisGwMap = new Map([[1, 2]]);
  const result = evaluateFreeHit(picks, fixtureThisGwMap);
  assert.strictEqual(result.blank_count, 0);
  assert.strictEqual(result.recommended, false);
  assert.match(result.reason, /all have fixtures/);
});

// ---- evaluateWildcard (pure) ----

test('evaluateWildcard: recommends a rebuild when a large share of the squad is troubled', () => {
  const picks = [1, 2, 3, 4].map((id) => starterPick(id, `P${id}`, id));
  const pool = poolFrom([
    poolPlayer(1, { status: 'i' }),
    poolPlayer(2, { status: 'a', form: '0.5' }), // cold form
    poolPlayer(3, { status: 'a', form: '5.0' }),
    poolPlayer(4, { status: 'a', form: '5.0' })
  ]);
  const result = evaluateWildcard(picks, pool);
  assert.strictEqual(result.troubled_count, 2);
  assert.strictEqual(result.recommended, true, '2 of 4 (50%) clears the ~27% bar');
  assert.match(result.reason, /P1/);
  assert.match(result.reason, /P2/);
});

test('evaluateWildcard: a healthy squad is not recommended for a rebuild', () => {
  const picks = [1, 2].map((id) => starterPick(id, `P${id}`, id));
  const pool = poolFrom([poolPlayer(1, { form: '6.0' }), poolPlayer(2, { form: '6.0' })]);
  const result = evaluateWildcard(picks, pool);
  assert.strictEqual(result.troubled_count, 0);
  assert.strictEqual(result.recommended, false);
  assert.match(result.reason, /looks healthy/);
});

// ---- evaluateChipOptions (pure) ----

test('evaluateChipOptions: ranks the available chips by signal and surfaces the strongest recommended one as `best`', () => {
  // A squad where Triple Captain should clearly win: one elite starter, a weak bench
  // that doesn't clear Bench Boost's bar, no blank gameweek, and a healthy squad.
  const picks = [
    starterPick(1, 'Elite', 1),
    starterPick(2, 'Ordinary', 2),
    benchPick(3, 'WeakBench', 3)
  ];
  const pool = poolFrom([
    poolPlayer(1, { form: '9.0', ep_next: '9.0', xgi_per_90: '0.9', ict_index: '300' }),
    poolPlayer(2, { form: '5.0', ep_next: '5.0' }),
    poolPlayer(3, { status: 'i' }) // bench player unavailable -- bboost shouldn't win
  ]);
  const fixtureThisGwMap = new Map([[1, 2], [2, 2]]); // team 3 (bench) blanks
  const result = evaluateChipOptions(picks, pool, fixtureThisGwMap, new Map(), []);
  assert.ok(result.chips.length > 0);
  assert.ok(result.best, 'A strong Triple Captain case should clear the recommend bar');
  assert.strictEqual(result.best.chip, '3xc');
});

test('evaluateChipOptions: excludes chips already in usedChips entirely, even if their signal would otherwise win', () => {
  const picks = [starterPick(1, 'Elite', 1)];
  const pool = poolFrom([poolPlayer(1, { form: '9.0', ep_next: '9.0' })]);
  const result = evaluateChipOptions(picks, pool, new Map(), new Map(), ['3xc']);
  assert.ok(!result.chips.some((c) => c.chip === '3xc'), 'Already-used Triple Captain should never appear in the ranked list');
});

test('evaluateChipOptions: `best` is null when nothing clears any chip\'s recommend bar', () => {
  const picks = [
    { player_id: 1, player_name: 'Starter1', squad_position: 1, player_team: 1 },
    { player_id: 2, player_name: 'Starter2', squad_position: 2, player_team: 2 },
    { player_id: 3, player_name: 'Starter3', squad_position: 3, player_team: 3 },
    { player_id: 4, player_name: 'Bench1', squad_position: 12, player_team: 4 },
    { player_id: 5, player_name: 'Bench2', squad_position: 13, player_team: 5 },
    { player_id: 6, player_name: 'Bench3', squad_position: 14, player_team: 6 },
    { player_id: 7, player_name: 'Bench4', squad_position: 15, player_team: 7 }
  ];
  const pool = poolFrom(picks.map((p) => poolPlayer(p.player_id, { form: '3.0', ep_next: '3.0' })));
  // Starters (teams 1-3) and half the bench (teams 4-5) have a fixture this week;
  // the other half of the bench (teams 6-7) blanks -- keeps Bench Boost's
  // contributing ratio at 50%, well under its 75% bar, and keeps every starter
  // covered so Free Hit's blank check doesn't fire either. Uniform healthy form
  // keeps Triple Captain's score and Wildcard's troubled-count both under their bars.
  const fixtureThisGwMap = new Map([[1, 3], [2, 3], [3, 3], [4, 3], [5, 3]]);
  const result = evaluateChipOptions(picks, pool, fixtureThisGwMap, new Map(), []);
  assert.strictEqual(result.best, null);
});

// ---- handleSquadAdvisor (I/O wrapper) ----

function dynamoRouter({ picksByGw = {}, bankByGw = {}, chipsByEntry = {}, fixtures = [] } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const ctor = command.constructor.name;

    if (table === 'seasons' && ctor === 'ScanCommand') {
      return { Items: [SEASON_ROW] };
    }
    if (table === 'fpl_fixture_data' && ctor === 'ScanCommand') {
      // handleSquadAdvisor now fetches the season's fixtures once (getSeasonFixtures)
      // to feed both getFixtureRunMap and getUpcomingChipWindows -- default is an empty
      // season so pre-existing tests that don't care about fixtures are unaffected.
      return { Items: fixtures };
    }
    if (table === 'fpl_entry_picks' && ctor === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':k'];
      return { Items: picksByGw[key] || [] };
    }
    if (table === 'fpl_entry_gameweek' && ctor === 'QueryCommand') {
      const se = command.input.ExpressionAttributeValues[':se'];
      const gw = command.input.ExpressionAttributeValues[':gw'];
      // getBankTenths queries a single gameweek (':gw' present); getUsedChips queries
      // the whole season (no ':gw' at all) -- same table, distinguished by which
      // ExpressionAttributeValues the real KeyConditionExpression actually bound.
      if (gw !== undefined) {
        const bank = bankByGw[`${se}#${gw}`];
        return { Items: typeof bank === 'number' ? [{ bank }] : [] };
      }
      const chips = chipsByEntry[se] || [];
      return { Items: chips.map((active_chip) => ({ active_chip })) };
    }
    return undefined;
  };
}

function bootstrapFetchMock(elements) {
  return installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ elements }));
    }
    return null;
  });
}

test('handleSquadAdvisor: missing entry_id returns 400 without touching the database', async () => {
  const dynamoMock = installDynamoMock(() => {
    throw new Error('Should not query DynamoDB when entry_id is missing');
  });

  try {
    const response = await handleSquadAdvisor({}, CORS);
    assert.strictEqual(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.match(body.error, /entry_id/);
  } finally {
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: no picks + preseason returns transfer.reason "season_not_started"', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: false, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '1' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.found, false);
    assert.strictEqual(body.transfer.reason, 'season_not_started');
    assert.deepStrictEqual(body.used_chips, [], 'used_chips is fetched independently of picks, and should still come back (empty here)');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: no picks + season live returns transfer.reason "no_data"', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: true, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '1' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.found, false);
    assert.strictEqual(body.transfer.reason, 'no_data');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: full success -- fetches live pool + bank and returns a real found:true suggestion', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 },
    { player_id: 6, player_name: 'Salah', player_position: 3, squad_position: 6, player_team: 14 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 5, web_name: 'Saka', element_type: 3, now_cost: 100, form: '1.0', ep_next: '2.0', status: 'a', selected_by_percent: '30.0' },
    { id: 6, web_name: 'Salah', element_type: 3, now_cost: 130, form: '8.0', ep_next: '7.0', status: 'a', selected_by_percent: '40.0' },
    { id: 50, web_name: 'ReplacementMid', element_type: 3, now_cost: 105, form: '9.0', ep_next: '8.0', status: 'a', selected_by_percent: '5.0' }
  ]);
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks },
    bankByGw: { '2026/27#728477#5': 5 }, // £0.5m bank -> 5 tenths
    chipsByEntry: { '2026/27#728477': ['bboost'] }
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.season, '2026/27');
    assert.strictEqual(body.gameweek, 5);
    assert.strictEqual(body.transfer.found, true);
    assert.strictEqual(body.transfer.out.player_id, 5, 'Saka has the coldest form (1.0) of the two -- should be the OUT candidate');
    assert.strictEqual(body.transfer.in.player_id, 50, 'ReplacementMid is the only affordable, unowned MID candidate');
    assert.ok(body.transfer.delta_pts > 0);
    assert.deepStrictEqual(body.used_chips, ['bboost']);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: used_chips collects distinct chips played across every gameweek this season', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 5, web_name: 'Saka', element_type: 3, now_cost: 100, form: '5.0', ep_next: '5.0', status: 'a' }
  ]);
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks },
    // Same chip appearing on more than one row (e.g. a re-synced row) should still
    // dedupe to a single entry -- 'wildcard' repeated plus '3xc' once should give
    // exactly 2 distinct chips back, not 3.
    chipsByEntry: { '2026/27#728477': ['wildcard', 'wildcard', '3xc'] }
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.used_chips.length, 2, 'Should dedupe the repeated wildcard entry');
    assert.ok(body.used_chips.includes('wildcard'));
    assert.ok(body.used_chips.includes('3xc'));
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: used_chips fails open to an empty array if the chip-history query errors', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 5, web_name: 'Saka', element_type: 3, now_cost: 100, form: '5.0', ep_next: '5.0', status: 'a' }
  ]);
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const ctor = command.constructor.name;
    if (table === 'seasons' && ctor === 'ScanCommand') return { Items: [SEASON_ROW] };
    if (table === 'fpl_fixture_data' && ctor === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && ctor === 'QueryCommand') {
      const key = command.input.ExpressionAttributeValues[':k'];
      return { Items: key === '2026/27#728477#5' ? picks : [] };
    }
    if (table === 'fpl_entry_gameweek' && ctor === 'QueryCommand') {
      const gw = command.input.ExpressionAttributeValues[':gw'];
      if (gw !== undefined) return { Items: [] }; // bank query -- fine
      throw new Error('DynamoDB unavailable'); // used-chips query -- simulate a failure
    }
    return undefined;
  });

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    assert.strictEqual(response.statusCode, 200, 'A failed chip-history query should never surface as a 500');
    const body = JSON.parse(response.body);
    assert.deepStrictEqual(body.used_chips, []);
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: upcoming_chip_windows reflects a blank/double gameweek detected from fpl_fixture_data, even when no picks exist yet', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 5, is_current: true, finished: false }] }));
    }
    return null;
  });
  const fixtures = [
    fixture(4, 1, 2, 2, 2),        // establishes teams 1 & 2 exist
    fixture(5, 1, 3, 2, 2),        // gw5: team 1 plays, team 2 blanks, team 3 introduced
  ];
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {}, fixtures }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.reason, 'no_data');
    const gw5 = body.upcoming_chip_windows.find((w) => w.gameweek === 5);
    assert.ok(gw5, 'gw5 should be flagged since team 2 has no fixture that week');
    assert.ok(gw5.blank_teams.includes(2));
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: the transfer suggestion accounts for fixtureRunMap built from live fixture data', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 5, web_name: 'Saka', element_type: 3, now_cost: 100, form: '2.0', ep_next: '4.0', status: 'a', selected_by_percent: '10.0', team: 1 },
    // Same ep_next/form as candidate below, but team 10 (hard run) vs team 20 (easy run).
    { id: 50, web_name: 'HardRun', element_type: 3, now_cost: 100, form: '4.0', ep_next: '4.0', status: 'a', selected_by_percent: '10.0', team: 10 },
    { id: 51, web_name: 'EasyRun', element_type: 3, now_cost: 100, form: '4.0', ep_next: '4.0', status: 'a', selected_by_percent: '10.0', team: 20 }
  ]);
  const fixtures = [
    fixture(5, 10, 20, 5, 1) // team 10 home @ diff 5 (hard), team 20 away @ diff 1 (easy)
  ];
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks },
    fixtures
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.found, true);
    assert.strictEqual(body.transfer.in.player_id, 51, 'The easier-fixture-run candidate should be preferred once fixtureRunMap is wired in');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: chip_recommendation reflects the manager\'s real bench, not hand-written mock content', async () => {
  const picks = [
    { player_id: 1, player_name: 'Starter', player_position: 3, squad_position: 1, player_team: 1 },
    { player_id: 2, player_name: 'RealBench1', player_position: 2, squad_position: 12, player_team: 2 },
    { player_id: 3, player_name: 'RealBench2', player_position: 3, squad_position: 13, player_team: 3 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 1, web_name: 'Starter', element_type: 3, now_cost: 100, form: '5.0', ep_next: '5.0', status: 'a' },
    { id: 2, web_name: 'RealBench1', element_type: 2, now_cost: 45, form: '3.0', ep_next: '2.0', status: 'a' },
    { id: 3, web_name: 'RealBench2', element_type: 3, now_cost: 45, form: '2.0', ep_next: '2.0', status: 'a' }
  ]);
  const fixtures = [
    fixture(5, 2, 3, 2, 2) // both bench players' teams play this week, difficulty 2
  ];
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks },
    fixtures
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    const body = JSON.parse(response.body);
    assert.ok(body.chip_recommendation, 'chip_recommendation should be present on the response');
    const bboostEntry = body.chip_recommendation.chips.find((c) => c.chip === 'bboost');
    assert.ok(bboostEntry, 'bboost should be among the ranked chips since it has not been used');
    assert.ok(bboostEntry.reason.includes('RealBench1') || bboostEntry.reason.includes('RealBench2'));
    assert.ok(!bboostEntry.reason.includes('Jordan Pickford'), 'The old hand-written mock name should never appear in real backend output');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: chip_recommendation.chips omits any chip already in used_chips', async () => {
  const picks = [
    { player_id: 1, player_name: 'Starter', player_position: 3, squad_position: 1, player_team: 1 },
    { player_id: 2, player_name: 'RealBench1', player_position: 2, squad_position: 12, player_team: 2 }
  ];
  const fetchMock = bootstrapFetchMock([
    { id: 1, web_name: 'Starter', element_type: 3, now_cost: 100, form: '9.0', ep_next: '9.0', status: 'a' },
    { id: 2, web_name: 'RealBench1', element_type: 2, now_cost: 45, form: '3.0', ep_next: '2.0', status: 'a' }
  ]);
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks },
    chipsByEntry: { '2026/27#728477': ['bboost', 'wildcard'] }
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    const body = JSON.parse(response.body);
    const chipKeys = body.chip_recommendation.chips.map((c) => c.chip);
    assert.ok(!chipKeys.includes('bboost'));
    assert.ok(!chipKeys.includes('wildcard'));
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('handleSquadAdvisor: a live pool fetch failure fails open to no_data rather than a 500', async () => {
  const picks = [
    { player_id: 5, player_name: 'Saka', player_position: 3, squad_position: 5, player_team: 3 }
  ];
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) return jsonResponse({}, { ok: false, status: 500 });
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({
    picksByGw: { '2026/27#728477#5': picks }
  }));

  try {
    const response = await handleSquadAdvisor({ entry_id: '728477', gw: '5' }, CORS);
    assert.strictEqual(response.statusCode, 200, 'A failed live-pool fetch should never surface as a 500');
    const body = JSON.parse(response.body);
    assert.strictEqual(body.transfer.found, false);
    assert.strictEqual(body.transfer.reason, 'no_data');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

// ---- Route ordering (index.mjs) ----
//
// '/manager-squad/advisor' also contains '/manager-squad' as a substring, so the more
// specific advisor route must be checked BEFORE the plain squad route or every advisor
// request would silently fall through to handleManagerSquad instead (wrong shape
// response: `players`, no `transfer` field at all).

function apiEvent(path, queryStringParameters) {
  return { httpMethod: 'GET', path, queryStringParameters };
}

test('index.mjs: /manager-squad/advisor dispatches to handleSquadAdvisor, not handleManagerSquad', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: true, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handler(apiEvent('/manager-squad/advisor', { entry_id: '728477', gw: '1' }));
    const body = JSON.parse(response.body);
    assert.ok('transfer' in body, 'Expected the advisor response shape (a `transfer` key)');
    assert.ok(!('players' in body), 'Should not have fallen through to the plain squad response shape');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});

test('index.mjs: plain /manager-squad still dispatches to handleManagerSquad', async () => {
  const fetchMock = installFetchMock((url) => {
    if (url.includes('bootstrap-static')) {
      return jsonResponse(buildBootstrapStatic({ events: [{ id: 1, is_current: true, finished: false }] }));
    }
    return null;
  });
  const dynamoMock = installDynamoMock(dynamoRouter({ picksByGw: {} }));

  try {
    const response = await handler(apiEvent('/manager-squad', { entry_id: '728477', gw: '1' }));
    const body = JSON.parse(response.body);
    assert.ok('players' in body, 'Expected the plain squad response shape (a `players` key)');
    assert.ok(!('transfer' in body), 'Plain /manager-squad should never return the advisor shape');
  } finally {
    fetchMock.restore();
    dynamoMock.restore();
  }
});
