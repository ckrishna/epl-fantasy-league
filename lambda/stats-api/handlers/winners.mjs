import { getGWWinners, getCurrentSeason, getActiveGameweek } from '../utils/dynamodb.mjs';

export async function handleWinners(corsHeaders) {
  const currentSeason = await getCurrentSeason();
  const winners = (await getGWWinners(currentSeason))
    .sort((a, b) => b.gameweek - a.gameweek)
    .map(w => ({
      gameweek: w.gameweek,
      winners: w.winners || [],
      winner_count: (w.winners || []).length,
      season: w.season
    }));

  // Derive the active gameweek from the winners data we actually have (the highest
  // gameweek present); only fall back to the live FPL lookup if we have no winners
  // cached yet at all. Previously this was a hardcoded `26`, disconnected from reality.
  const activeGameweek = winners.length > 0
    ? Math.max(...winners.map(w => w.gameweek))
    : await getActiveGameweek();

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      active_gameweek: activeGameweek,
      finished_gameweeks: winners,
      total_gameweeks_completed: winners.length,
      last_updated: winners[0]?.last_synced || null,
      timestamp: new Date().toISOString()
    })
  };
}
