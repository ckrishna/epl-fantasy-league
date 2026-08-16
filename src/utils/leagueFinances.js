// src/utils/leagueFinances.js
//
// New feature (no GH issue filed yet) -- per-league prize-pool tracking. Computes each
// manager's running/projected net winnings under the league's real rules, confirmed
// directly with the app owner:
//
//   - Buy-in: $30/manager (configurable per league -- see DEFAULT_MONEY_CONFIG).
//   - GW win payout: $5/gameweek, split evenly among ties.
//   - Last-place forgiveness: whoever is LAST in the standings passed in (current/live
//     standings for a mid-season projection, or final settled standings once the
//     season's actually over) forfeits a single GW win. If they won exactly one GW all
//     season, that $5 is reassigned to the RUNNER-UP of that SPECIFIC gameweek (not a
//     season-long runner-up -- re-rank that one week excluding the last-place
//     manager(s) and pay whoever's on top of what's left). Winning 0 GWs is moot
//     (nothing to reassign); winning 2+ GWs means they keep everything, no penalty.
//   - Season-end top-N payout: whatever's left of the pot (member_count * buy_in, minus
//     $5 * gameweeks_played so far) splits across the current top N of the SAME
//     standings passed in, by the configured percentages.
//
// This is the one real algorithm, not a mock stand-in for it -- what's still "mock"
// about this feature is that buy-in/payout/split live as hardcoded defaults here
// rather than a real per-league DynamoDB config table. Swapping DEFAULT_MONEY_CONFIG
// for a real per-league fetch is the only thing that should need to change once that
// table exists; the math itself doesn't.
//
// Known simplification, not yet asked about: if MULTIPLE managers are tied for last
// place, this treats their GW wins as one pooled count (any win by anyone in the tied
// group counts toward the ">1 win" threshold, and the single reassigned GW -- if
// any -- is whichever one of them actually won it). Revisit if a real tie-for-last
// case ever comes up.

// topSplits are WEIGHTS, not percentages -- they get normalized by their own sum, not
// assumed to add to 1.0. Confirmed against the app owner's own example: a 10-member
// league's overall pot is $110 (300 total - 190 in GW payouts), and "70/30/10" pays out
// exactly $70/$30/$10 for that pot -- i.e. 70/(70+30+10), 30/(70+30+10), 10/(70+30+10)
// of whatever the overall pot actually is. Using [0.70, 0.30, 0.10] as literal fractions
// would only be correct by coincidence for a pot where the weights already sum to 100;
// they sum to 110 here, so normalizing is the only way this generalizes to other pot
// sizes / member counts while still reproducing the $70/$30/$10 example exactly.
export const DEFAULT_MONEY_CONFIG = {
  buyIn: 30,
  gwPayout: 5,
  topSplits: [70, 30, 10]
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
// config: {buyIn, gwPayout, topSplits} -- see DEFAULT_MONEY_CONFIG.
export async function computeLeagueFinances({ standings, winnersHistory, fetchGwStandings, config = DEFAULT_MONEY_CONFIG }) {
  const { buyIn, gwPayout, topSplits } = config;
  const won = new Map();

  const addWinnings = (managerId, amount) => {
    const key = String(managerId);
    won.set(key, (won.get(key) || 0) + amount);
  };

  if (standings.length === 0) return new Map();

  const lastRank = Math.max(...standings.map((s) => s.rank));
  const lastPlaceIds = new Set(standings.filter((s) => s.rank === lastRank).map((s) => String(s.manager_id)));

  const lastPlaceWins = [];
  for (const gw of winnersHistory) {
    for (const w of gw.winners) {
      if (lastPlaceIds.has(String(w.entry_id))) lastPlaceWins.push(gw.gameweek);
    }
  }
  const forfeitGameweek = lastPlaceWins.length === 1 ? lastPlaceWins[0] : null;

  for (const gw of winnersHistory) {
    if (gw.gameweek === forfeitGameweek) {
      const gwStandings = await fetchGwStandings(gw.gameweek);
      const eligible = gwStandings.filter((s) => !lastPlaceIds.has(String(s.manager_id)));
      if (eligible.length > 0) {
        const topScore = Math.max(...eligible.map((s) => s.net_points ?? 0));
        const runnersUp = eligible.filter((s) => (s.net_points ?? 0) === topScore);
        const share = gwPayout / runnersUp.length;
        runnersUp.forEach((r) => addWinnings(r.manager_id, share));
      }
      // If nobody's eligible (everyone tied for last, degenerate edge case), the $5
      // just isn't awarded rather than guessing who "should" get it.
      continue;
    }
    const share = gwPayout / Math.max(1, gw.winners.length);
    gw.winners.forEach((w) => addWinnings(w.entry_id, share));
  }

  const memberCount = standings.length;
  const gwsPlayed = winnersHistory.length;
  const totalPot = memberCount * buyIn;
  const gwPot = gwsPlayed * gwPayout;
  const overallPot = Math.max(0, totalPot - gwPot);

  const weightSum = topSplits.reduce((a, b) => a + b, 0) || 1;
  const topN = [...standings].sort((a, b) => a.rank - b.rank).slice(0, topSplits.length);
  topN.forEach((manager, i) => {
    addWinnings(manager.manager_id, (overallPot * topSplits[i]) / weightSum);
  });

  const result = new Map();
  for (const s of standings) {
    const totalWon = won.get(String(s.manager_id)) || 0;
    result.set(String(s.manager_id), {
      totalWon: round2(totalWon),
      net: round2(totalWon - buyIn)
    });
  }
  return result;
}
