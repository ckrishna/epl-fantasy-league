// One-off debug script (2026-08-16): reproduces the live "Who has good fixtures coming
// up?" decline WITHOUT a full Lambda redeploy each iteration. The genbi-fixtureRun and
// genbi-nextGwProjections diagnostic logs (added this session) already proved the DATA
// reaches leagueContext correctly in production -- fixture_run had 20 populated teams,
// next_gw_projections had 30 populated players -- yet Claude still declined with a
// generic "I don't have fixture data" answer. That means the bug (if real) is in how
// Claude reasons over the prompt, not in the data pipeline, which the mocked
// genbi-*.test.mjs suite structurally cannot catch (see eval-genbi-live.mjs's header
// comment for the same limitation). This script calls the REAL askClaude() directly so
// prompt wording can be iterated on in seconds instead of a full zip/deploy/re-ask cycle.
//
// Usage: node scripts/debug-fixture-run.mjs
//   Requires real AWS credentials with bedrock:InvokeModel access (same as
//   eval-genbi-live.mjs). Costs a few cents per run -- not part of CI, not scheduled.
//
// The context below is copied directly from the live 2026-08-16 06:20:02 UTC
// "fixtureRun diagnostic" / "nextGwProjections diagnostic" CloudWatch log lines (3 of
// the 20 real teams, 3 of the 30 real players) -- not synthetic data, so if Claude
// declines against this exact shape, it reproduces the live bug precisely.

import { askClaude } from '../utils/bedrock.mjs';

const leagueContext = {
  gameweek: 1,
  current_standings: [],
  recent_form_summary: {},
  total_season_summary: {},
  players_gw_data: [],
  season_totals: [],
  our_league_picks: [],
  manager_season_stats: [],
  ownership_aggregates: { most_owned_player: null, differentials: [] },
  top_captain_picks: { best: [], worst: [] },
  next_gw_projections: {
    next_gameweek: 1,
    players: [
      { name: 'Raya', team_name: 'Arsenal', price: 6, projected_points: 4, next_fixture: { opponent: 'Coventry City', is_home: true, difficulty: 2 } },
      { name: 'Gabriel', team_name: 'Arsenal', price: 8, projected_points: 4, next_fixture: { opponent: 'Coventry City', is_home: true, difficulty: 2 } },
      { name: 'Haaland', team_name: 'Man City', price: 15.5, projected_points: 4, next_fixture: { opponent: 'Bournemouth', is_home: true, difficulty: 3 } }
    ]
  },
  fixture_run: {
    from_gameweek: 1,
    to_gameweek: 5,
    teams: [
      {
        team_name: 'Liverpool', average_difficulty: 2.6, fixture_count: 5,
        fixtures: [
          { gameweek: 1, opponent: 'Newcastle', is_home: false, difficulty: 3 },
          { gameweek: 2, opponent: "Nott'm Forest", is_home: true, difficulty: 3 },
          { gameweek: 3, opponent: 'Ipswich Town', is_home: false, difficulty: 2 },
          { gameweek: 4, opponent: 'Fulham', is_home: true, difficulty: 2 },
          { gameweek: 5, opponent: 'Bournemouth', is_home: false, difficulty: 3 }
        ]
      },
      {
        team_name: 'Leeds', average_difficulty: 2.8, fixture_count: 5,
        fixtures: [
          { gameweek: 1, opponent: "Nott'm Forest", is_home: false, difficulty: 3 },
          { gameweek: 2, opponent: 'Brentford', is_home: true, difficulty: 3 },
          { gameweek: 3, opponent: 'Brighton', is_home: false, difficulty: 3 },
          { gameweek: 4, opponent: 'Newcastle', is_home: true, difficulty: 2 },
          { gameweek: 5, opponent: 'Crystal Palace', is_home: true, difficulty: 3 }
        ]
      },
      {
        team_name: 'Man Utd', average_difficulty: 2.8, fixture_count: 5,
        fixtures: [
          { gameweek: 1, opponent: 'Hull City', is_home: false, difficulty: 2 },
          { gameweek: 2, opponent: 'Ipswich Town', is_home: true, difficulty: 2 },
          { gameweek: 3, opponent: 'Everton', is_home: false, difficulty: 3 },
          { gameweek: 4, opponent: 'Man City', is_home: true, difficulty: 4 },
          { gameweek: 5, opponent: 'Fulham', is_home: false, difficulty: 3 }
        ]
      }
    ]
  }
};

const question = 'Who has good fixtures coming up?';

console.log(`Asking: "${question}"\n`);
const result = await askClaude(question, leagueContext);
console.log('--- RAW ANSWER ---');
console.log(result.response);
console.log('\n--- USAGE ---');
console.log(result.usage);
