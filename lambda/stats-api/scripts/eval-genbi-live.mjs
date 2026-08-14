// #39 Phase 4: live-model eval harness.
//
// Why this exists: the regular `node --test` suite (all `genbi-*.test.mjs` files) mocks
// Bedrock entirely -- it proves the right DATA reaches the prompt, but it structurally
// cannot catch prompt-ambiguity or model-REASONING bugs, since the mock never actually
// reasons over the instructions. Confirmed live: the win-count routing bug and the
// consecutive-win-streak decline (both fixed in #39) would have passed the full mocked
// suite unchanged before their fixes, because nothing in that suite ever asked the real
// model a real question.
//
// Design: unlike handleGenBI (which builds leagueContext by querying live DynamoDB
// tables, whose contents drift week to week), every case here uses a small, HAND-BUILT,
// fully-known context -- the same shape the mocked test suite's fixtures already use,
// just fed to the REAL askClaude() instead of a mock. That makes every expected answer
// a fixed, computable fact (e.g. "Haaland scored 20 as captain -> the correct captain
// score is exactly 40"), so a check can assert on it reliably instead of chasing
// whatever real league data happens to look like on the day this runs. This also means
// the script needs Bedrock access but NOT live DynamoDB access at all.
//
// Budget: shares the same daily cost guardrail production traffic uses
// (utils/genbi-budget.mjs) -- checks before every case and stops early if the day's
// budget is already spent, and records each call's real cost so a scheduled run doesn't
// silently eat into budget headroom managers might need later that day.
//
// Usage: node scripts/eval-genbi-live.mjs
//   Requires real AWS credentials with bedrock:InvokeModel + DynamoDB access to
//   genbi-usage-daily (budget tracking only -- no other table is touched).
//   Intended to be run periodically by a person (weekly, say), NOT on every commit --
//   each run costs real money and there's no reason to burn budget on unchanged prompt
//   behavior. Exits non-zero if any case fails, so it CAN be wired into a scheduled
//   check if you want a failure to be visible somewhere.

import { askClaude } from '../utils/bedrock.mjs';
import { checkBudget, recordUsage } from '../utils/genbi-budget.mjs';

// Deliberately small and round so the "correct" answer is unambiguous: GW10, one
// captain pick with an exact doubling, one clean season leader, one manager with no
// transfer-quality data available (so "best transfers" MUST decline, not guess).
const BASE_CONTEXT = {
  gameweek: 10,
  current_standings: [
    { rank: 1, manager: 'Chetan Bk (COYS)', total_points: 620, points_this_week: 58, gameweek: 10 },
    { rank: 2, manager: 'Da Movement', total_points: 590, points_this_week: 45, gameweek: 10 }
  ],
  total_season_summary: { 'Chetan Bk (COYS)': 6, 'Da Movement': 4 },
  recent_form_summary: { 'Da Movement': 3, 'Chetan Bk (COYS)': 2 },
  players_gw_data: [
    { name: 'Haaland', team_name: 'Man City', points: 20, form: 8.5, ownership: '45.0%' },
    { name: 'Salah', team_name: 'Liverpool', points: 12, form: 6.1, ownership: '38.0%' }
  ],
  our_league_picks: [
    { manager: 'Chetan Bk (COYS)', player: 'Haaland', is_captain: true, points: 20 },
    { manager: 'Da Movement', player: 'Salah', is_captain: true, points: 12 }
  ],
  season_totals: [
    { name: 'Haaland', team_name: 'Man City', points: 180, ownership: '45.0%' },
    { name: 'Salah', team_name: 'Liverpool', points: 140, ownership: '38.0%' }
  ],
  manager_season_stats: [
    {
      manager: 'Chetan Bk (COYS)', gameweeks_played: 10, highest_gw_score: 78, lowest_gw_score: 32,
      average_points_per_gw: 62, total_transfers_made: 8, total_transfer_hits: 4,
      chips_used: [{ chip: 'wildcard', gameweek: 6 }], chips_used_totals: null,
      bench_points_wasted: 22, captain_points_season: 210, current_win_streak: 2, longest_win_streak: 3
    }
  ],
  ownership_aggregates: {
    most_owned_player: { player: 'Haaland', ownership_count: 2, owned_by: ['Chetan Bk (COYS)', 'Da Movement'], points_this_gw: 20 },
    differentials: [{ player: 'Watkins', ownership_count: 1, owned_by: ['Da Movement'], points_this_gw: 9 }]
  },
  top_captain_picks: {
    best: [{ manager: 'Chetan Bk (COYS)', player: 'Haaland', gameweek: 10, raw_points: 20, multiplier: 2, total_points: 40 }],
    worst: [{ manager: 'Da Movement', player: 'Salah', gameweek: 3, raw_points: 0, multiplier: 2, total_points: 0 }]
  },
  next_gw_projections: {
    next_gameweek: 11,
    players: [
      { name: 'Haaland', team_name: 'Man City', price: 15.0, projected_points: 8.5, next_fixture: { opponent: 'Everton', is_home: true, difficulty: 2 } },
      { name: 'Salah', team_name: 'Liverpool', price: 13.0, projected_points: 7.2, next_fixture: { opponent: 'Arsenal', is_home: false, difficulty: 4 } }
    ]
  }
};

const HEDGE_PATTERNS = [
  /i don'?t have/i, /not available/i, /no data/i, /unable to/i,
  /i'?m not sure/i, /can'?t determine/i, /don'?t know/i, /no information/i
];
function isHedge(answer) {
  return HEDGE_PATTERNS.some((p) => p.test(answer));
}

// Each `context` is BASE_CONTEXT unless overridden -- keeps every case's expected
// answer traceable to a specific, small diff from the shared fixture above.
const CASES = [
  {
    id: 'captain-math-gw-scoped',
    question: 'What was the captain score this gameweek?',
    context: BASE_CONTEXT,
    check: (a) => a.includes('40') && !isHedge(a),
    why: 'Haaland scored 20 as captain (x2) -- instruction 2 requires showing this exact math, capped under 60'
  },
  {
    id: 'player-form-vs-manager-form',
    question: 'Which players are in form?',
    context: BASE_CONTEXT,
    check: (a) => /haaland/i.test(a) && !isHedge(a),
    why: 'Instruction 1: a question naming "players" should read player_data.form (Haaland 8.5), not recent_form_summary (manager win streaks)'
  },
  {
    id: 'manager-win-count-routing',
    question: 'Which manager has the most GW wins?',
    context: BASE_CONTEXT,
    check: (a) => /chetan/i.test(a) && !isHedge(a),
    why: 'Instruction 5: plain "most wins" (no "recently"/"lately") must read total_season_summary (Chetan: 6), not recent_form_summary (Da Movement: 3) -- this exact bug shipped once before'
  },
  {
    id: 'standings-direct-answer',
    question: 'What are the current standings?',
    context: BASE_CONTEXT,
    check: (a) => /chetan/i.test(a) && !isHedge(a),
    why: 'Instruction 6: must answer directly from current_standings, never decline "standings" as unavailable'
  },
  {
    id: 'differential-scoped-to-league',
    question: 'Which player is a differential?',
    context: BASE_CONTEXT,
    check: (a) => /watkins/i.test(a) && !isHedge(a),
    why: 'Instruction 8: differentials must come from ownership_aggregates (Watkins, owned by exactly 1 manager here), not global FPL ownership%'
  },
  {
    id: 'best-transfers-must-decline',
    question: 'Who made the best transfers?',
    context: BASE_CONTEXT,
    check: (a) => isHedge(a),
    why: 'Instruction 7: no player-level transfer log exists (only activity counts) -- MUST decline plainly rather than guess. A confident-sounding answer here is the failure mode this case exists to catch.'
  },
  {
    id: 'next-gw-captain-is-projection-not-fact',
    question: "Who's a good captain pick for next gameweek?",
    context: BASE_CONTEXT,
    check: (a) => /haaland/i.test(a) && /project|expect|likely|based on/i.test(a) && !isHedge(a),
    why: 'Instruction 10: must recommend from next_gw_projections (Haaland has the higher projected_points + easier fixture) AND use projection/uncertainty language, not state it as settled fact'
  },
  {
    id: 'next-gw-null-must-decline-not-guess',
    question: "Who's a good captain pick for next gameweek?",
    context: { ...BASE_CONTEXT, next_gw_projections: null },
    check: (a) => isHedge(a),
    why: 'Instruction 10: when next_gw_projections is null (historical season / no upcoming gameweek), must say so plainly rather than falling back to some other field and guessing'
  }
];

async function runEval() {
  const budget = await checkBudget();
  if (budget.overBudget) {
    console.log(`Today's GenBI budget is already spent ($${budget.costSoFar.toFixed(2)}) -- skipping this eval run entirely.`);
    process.exitCode = 1;
    return;
  }

  let passed = 0;
  let failed = 0;
  let totalCost = 0;

  for (const c of CASES) {
    const result = await askClaude(c.question, c.context);
    const cost = await recordUsage({
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0
    });
    totalCost += cost;

    const ok = c.check(result.response);
    ok ? passed++ : failed++;

    console.log(`${ok ? 'PASS' : 'FAIL'} [${c.id}]  ($${cost.toFixed(4)})`);
    if (!ok) {
      console.log(`  why this case exists: ${c.why}`);
      console.log(`  question: ${c.question}`);
      console.log(`  answer:   ${result.response.replace(/\n/g, ' ')}`);
    }
  }

  console.log(`\n${passed}/${CASES.length} passed -- total cost this run: $${totalCost.toFixed(4)}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runEval().catch((err) => {
  console.error('Eval run crashed:', err);
  process.exitCode = 1;
});
