// Deterministic field router for GenBI.
//
// Why this exists: genbi.mjs used to fetch and send all 6 context fields
// (current_standings, total_season_summary, recent_form_summary, players_gw_data,
// season_totals, our_league_picks) on every single question, regardless of whether
// that question needed them. That's fine at 6 fields, but doesn't scale -- every
// future field #39 adds (streaks, bench points, chips, transfers, captaincy record,
// player form...) would make EVERY question pay for the entire system's capability
// instead of just what it asked for, which fights the daily Bedrock budget cap
// directly.
//
// Deliberately NOT a model call. A second Bedrock invocation per question would
// double cost and latency on a budget-capped project, and -- just as importantly --
// would make routing itself as untestable as final-answer quality already is. This
// stays a plain deterministic function so it can be fully unit tested the same way
// everything else in this codebase is, with no live model involved.
//
// Safety principle: when a question doesn't clearly match anything, default to
// fetching EVERYTHING (the previous, always-on behavior) rather than guessing narrow.
// Under-fetching produces a wrong/declined answer; over-fetching only costs a few
// extra tokens. This is a floor, not a ceiling -- known question shapes get narrowed
// down; anything unrecognized falls back to full safety.
//
// This only decides WHICH fields to fetch/include. It does not replace the
// <instructions> block in bedrock.mjs, which still does the finer-grained semantic
// disambiguation (e.g. "most wins" vs "form" once total_season_summary AND
// recent_form_summary are both already included).

const KEYWORD_GROUPS = {
  standings: ['standing', 'table', 'leading', 'leader', 'winning', 'rank', 'position', 'first place', 'top of the'],
  seasonWins: ['win', 'wins', 'won'],
  recentForm: ['form', 'recently', 'lately', 'last 5', 'last five', 'trending'],
  // Deliberately NOT bare "gameweek"/"gw" -- "most GW wins" is a manager-level
  // question, not a request for single-gameweek player data. Only trigger on an
  // explicit numbered reference ("GW5", "gameweek 5") via NUMBERED_GW_PATTERN below,
  // or unambiguous player-scoped phrasing.
  playerGwData: ['this week', 'this gameweek', 'captain', 'scored', 'player'],
  seasonTotals: ['season', 'overall', 'total points', 'whole season'],
  managerPicks: ['captain', 'captaincy', 'vice captain', 'armband', 'picks'],
  // #39 Phase 1: manager-level season aggregates (streaks, high/low GW score, season
  // average, transfer activity, chips, bench points wasted, season captaincy points).
  managerStats: [
    'streak', 'consecutive', 'transfer', 'transfers', 'hit', 'hits', 'chip', 'chips',
    'wildcard', 'bench', 'highest score', 'lowest score', 'best gameweek', 'worst gameweek',
    'average points', 'average score', 'most transfers', 'best transfers'
  ],
  // #39 Phase 2: ownership aggregates (most-owned player, differentials) within our
  // own league's squads for the resolved gameweek.
  // Deliberately NOT the bare substring "own" -- it false-positives on "shown", "known",
  // "grown", "brown", etc. via .includes(). "owns"/"owned"/"ownership" are specific
  // enough to keep as substrings.
  ownership: [
    'differential', 'differentials', 'owns', 'owned', 'ownership', 'unique',
    'exclusively', 'most owned', 'nobody else has', 'no one else has'
  ]
};

// Matches an explicit single-gameweek reference like "GW5", "gw 12", "gameweek 5" --
// a much more precise signal for "this needs single-gameweek player data" than the
// bare word "gameweek" (which "GW winners"/"most GW wins" also contain, but those are
// manager-level, not player-level, questions).
const NUMBERED_GW_PATTERN = /\bgw\s?\d+\b|\bgameweek\s+\d+\b/i;

// "captain"/"captaincy"/"armband" already trigger managerPicks (this-gameweek-only
// picks) via KEYWORD_GROUPS above -- but a SEASON-scoped captain question ("best
// captain picks this season?") needs manager_season_stats.captain_points_season
// instead, which managerPicks alone never pulls in. Confirmed live: this question was
// declining with "no season-long captain data available" even though
// captain_points_season has existed since #39 Phase 1 -- the router just never sent
// it, because no keyword in the managerStats group mentions "captain" at all.
const CAPTAIN_KEYWORDS = ['captain', 'captaincy', 'armband'];

const ALL_TRUE = {
  standings: true,
  seasonWins: true,
  recentForm: true,
  playerGwData: true,
  seasonTotals: true,
  managerPicks: true,
  managerStats: true,
  ownership: true
};

// Returns which context fields a question needs. Every key is always present
// (true/false) so callers never have to guard against undefined.
export function selectRelevantFields(question) {
  const q = (question || '').toLowerCase();

  const fields = {};
  for (const [field, keywords] of Object.entries(KEYWORD_GROUPS)) {
    fields[field] = keywords.some((kw) => q.includes(kw));
  }
  if (NUMBERED_GW_PATTERN.test(q)) {
    fields.playerGwData = true;
  }

  // A captain question with season-scope wording ("this season", "overall", "whole
  // season" -- the same seasonTotals keyword group) needs manager_season_stats too,
  // not just this-gameweek manager_picks.
  if (fields.seasonTotals && CAPTAIN_KEYWORDS.some((kw) => q.includes(kw))) {
    fields.managerStats = true;
  }

  const matchedAnything = Object.values(fields).some(Boolean);
  if (!matchedAnything) {
    return { ...ALL_TRUE };
  }

  return fields;
}
