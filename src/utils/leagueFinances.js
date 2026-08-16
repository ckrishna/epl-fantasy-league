// src/utils/leagueFinances.js
//
// Real per-league prize-pool tracking (GH issue not yet filed). Computes each manager's
// running/projected net winnings under a league's own configured rules -- confirmed
// directly with the app owner for Carpe Diem, but every number below is a per-league
// config value now (see DEFAULT_MONEY_CONFIG + backend's getMoneyConfigForLeagueId),
// not a hardcoded constant. A league with no config seeded gets `money_config: null`
// from the API and never calls into this file at all -- see Standings.jsx.
//
//   - Buy-in: dollars/manager (config.buyIn).
//   - GW win payout: config.gwPayout/gameweek, split evenly among ties (the ingester
//     already returns every manager tied for a gameweek's top NET score, not just one
//     -- see fpl-data-ingester/index.mjs's maxNetPoints/winners computation).
//   - Last-place forgiveness (config.lastPlaceMinWinsToKeep, 0 = rule off): whoever is
//     LAST in the standings passed in (current/live standings for a mid-season
//     projection, or final settled standings once the season's actually over) forfeits
//     ALL their GW winnings unless they won at least that many gameweeks outright. Each
//     forfeited week's payout is reassigned to the RUNNER-UP of that SPECIFIC gameweek
//     (not a season-long runner-up -- re-rank that one week excluding the last-place
//     manager(s) and pay whoever's on top of what's left, split evenly if that's also a
//     tie). Carpe Diem's confirmed real rule is lastPlaceMinWinsToKeep: 2 ("more than
//     one win to keep it"), which only ever has a single forfeitable week in practice
//     (win count 0 is moot -- nothing to reassign -- and 1 is the only nonzero case
//     below the threshold) -- but the general form below handles any threshold a
//     different league might configure, not just 2.
//   - Season-end top-N payout: whatever's left of the pot (member_count * buyIn, minus
//     gwPayout * gameweeks_played so far) splits across the current top N of the SAME
//     standings passed in, weighted by config.topSplits.
//
// Known simplification, not yet asked about: if MULTIPLE managers are tied for last
// place, this treats their GW wins as one pooled count (any win by anyone in the tied
// group counts toward the threshold, and each forfeited week -- if any -- is whichever
// one of them actually won it). Revisit if a real tie-for-last case ever comes up.

// topSplits are WEIGHTS, not percentages -- they get normalized by their own sum, not
// assumed to add to 1.0. Confirmed against the app owner's own example: a 10-member
// league's overall pot is $110 (300 total - 190 in GW payouts), and "70/30/10" pays out
// exactly $70/$30/$10 for that pot -- i.e. 70/(70+30+10), 30/(70+30+10), 10/(70+30+10)
// of whatever the overall pot actually is. Using [0.70, 0.30, 0.10] as literal fractions
// would only be correct by coincidence for a pot where the weights already sum to 100;
// they sum to 110 here, so normalizing is the only way this generalizes to other pot
// sizes / member counts while still reproducing the $70/$30/$10 example exactly.
//
// This default only matters for local/dev testing now -- the real UI always passes the
// per-league config it got back from the API (see Standings.jsx), never this constant.
export const DEFAULT_MONEY_CONFIG = {
  buyIn: 30,
  gwPayout: 5,
  topSplits: [70, 30, 10],
  lastPlaceMinWinsToKeep: 2
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

// standings: array of {manager_id, rank, ...} -- whichever standings you pass in
//   (current live, or final settled) decides who counts as "last place" and "top N"
//   here. Must already have `rank` set (Standings.jsx computes this after sorting).
// winnersHistory: array of {gameweek, winners: [{entry_id, ...}]} -- same shape as
//   getWinners()'s finished_gameweeks.
// fetchGwStandings: async (gameweek) => that single gameweek's full standings array
//   (each row shaped like getStandings(gw, ...)'s response: {manager_id, net_points}).
//   Called AT MOST ONCE, and only if the last-place manager(s) won exactly one GW --
//   the expensive per-gameweek lookup never fires for the common case.
// config: {buyIn, gwPayout, topSplits, lastPlaceMinWinsToKeep} -- see
//   DEFAULT_MONEY_CONFIG. lastPlaceMinWinsToKeep of 0/null/undefined turns the
//   forgiveness rule off entirely -- last place keeps every GW win like anyone else.
export async function computeLeagueFinances({ standings, winnersHistory, fetchGwStandings, config = DEFAULT_MONEY_CONFIG }) {
  const { buyIn, gwPayout, topSplits, lastPlaceMinWinsToKeep = 0 } = config;
  const won = new Map();
  // Per-manager line items backing the "how did I get this number" breakdown UI
  // (Standings.jsx's money badge, click to expand) -- every dollar in `won` traces back
  // to exactly one push here, so the breakdown always sums to the same total shown on
  // the badge. Line item shapes: {type: 'gw_win', gameweek, amount, tieCount},
  // {type: 'gw_reassigned', gameweek, amount, tieCount} (a forfeited last-place win,
  // reassigned to that week's own runner-up), {type: 'top_split', rank, amount},
  // {type: 'buy_in', amount} (always negative, always exactly one per manager).
  const breakdown = new Map();

  const addLineItem = (managerId, item) => {
    const key = String(managerId);
    if (!breakdown.has(key)) breakdown.set(key, []);
    breakdown.get(key).push(item);
  };

  const addWinnings = (managerId, amount, item) => {
    const key = String(managerId);
    won.set(key, (won.get(key) || 0) + amount);
    if (item) addLineItem(managerId, { ...item, amount: round2(amount) });
  };

  // Before a single gameweek has actually finished, `standings` is just whatever
  // arbitrary order zero-point managers happen to come back in -- not real standings --
  // and gwsPlayed below would be 0, which means gwPot is 0 and the ENTIRE buy-in pot
  // (member_count * buyIn) would get treated as "left over" for the season-end top-N
  // payout, producing a huge, meaningless number for whoever's sorted first. Nothing
  // has actually been won yet, so there's nothing to compute -- confirmed live
  // (2026-08-16): a 9-member league pre-GW1 showed a $171.82 "1st place" payout, which
  // was 70% of the full $270 pot, not an error in the split math, just this guard
  // missing.
  if (standings.length === 0 || winnersHistory.length === 0) return new Map();

  const lastRank = Math.max(...standings.map((s) => s.rank));
  const lastPlaceIds = new Set(standings.filter((s) => s.rank === lastRank).map((s) => String(s.manager_id)));

  const lastPlaceWins = [];
  for (const gw of winnersHistory) {
    for (const w of gw.winners) {
      if (lastPlaceIds.has(String(w.entry_id))) lastPlaceWins.push(gw.gameweek);
    }
  }
  // General form: last place forfeits EVERY gameweek they won, provided their win count
  // came in under the configured threshold. Naturally covers 0 wins (empty set, nothing
  // to reassign -- moot) and generalizes past the "exactly 1" case a threshold of 2
  // happens to reduce to: a league configured with, say, lastPlaceMinWinsToKeep: 3 and
  // a last-place manager who won 2 gameweeks would forfeit BOTH, not just one.
  const forfeitGameweeks = (lastPlaceMinWinsToKeep > 0 && lastPlaceWins.length > 0 && lastPlaceWins.length < lastPlaceMinWinsToKeep)
    ? new Set(lastPlaceWins)
    : new Set();

  for (const gw of winnersHistory) {
    if (forfeitGameweeks.has(gw.gameweek)) {
      const gwStandings = await fetchGwStandings(gw.gameweek);
      const eligible = gwStandings.filter((s) => !lastPlaceIds.has(String(s.manager_id)));
      if (eligible.length > 0) {
        const topScore = Math.max(...eligible.map((s) => s.net_points ?? 0));
        const runnersUp = eligible.filter((s) => (s.net_points ?? 0) === topScore);
        const share = gwPayout / runnersUp.length;
        runnersUp.forEach((r) => addWinnings(r.manager_id, share, {
          type: 'gw_reassigned',
          gameweek: gw.gameweek,
          tieCount: runnersUp.length
        }));
      }
      // If nobody's eligible (everyone tied for last, degenerate edge case), the
      // payout just isn't awarded rather than guessing who "should" get it.
      continue;
    }
    const share = gwPayout / Math.max(1, gw.winners.length);
    gw.winners.forEach((w) => addWinnings(w.entry_id, share, {
      type: 'gw_win',
      gameweek: gw.gameweek,
      tieCount: gw.winners.length
    }));
  }

  const memberCount = standings.length;
  const gwsPlayed = winnersHistory.length;
  const totalPot = memberCount * buyIn;
  const gwPot = gwsPlayed * gwPayout;
  const overallPot = Math.max(0, totalPot - gwPot);

  const weightSum = topSplits.reduce((a, b) => a + b, 0) || 1;
  const topN = [...standings].sort((a, b) => a.rank - b.rank).slice(0, topSplits.length);
  topN.forEach((manager, i) => {
    addWinnings(manager.manager_id, (overallPot * topSplits[i]) / weightSum, {
      type: 'top_split',
      rank: i + 1
    });
  });

  // Buy-in is the one line item every manager gets, win or lose -- added last so it's
  // not clobbered by an earlier addWinnings call, and tracked as its own negative
  // amount (not just folded into `net` at the end) so the breakdown UI can show it as
  // an explicit line rather than an unexplained gap between totalWon and net.
  standings.forEach((s) => addLineItem(s.manager_id, { type: 'buy_in', amount: round2(-buyIn) }));

  const result = new Map();
  for (const s of standings) {
    const totalWon = won.get(String(s.manager_id)) || 0;
    result.set(String(s.manager_id), {
      totalWon: round2(totalWon),
      net: round2(totalWon - buyIn),
      breakdown: breakdown.get(String(s.manager_id)) || []
    });
  }
  return result;
}
