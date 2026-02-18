import { getGWWinners } from '../utils/dynamodb.mjs';

export async function handleWinners(corsHeaders) {
  const winners = (await getGWWinners())
    .sort((a, b) => b.gameweek - a.gameweek)
    .map(w => ({
      gameweek: w.gameweek,
      winners: w.winners || [],
      winner_count: (w.winners || []).length,
      season: w.season
    }));

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      active_gameweek: 26,
      finished_gameweeks: winners,
      total_gameweeks_completed: winners.length,
      last_updated: winners[0]?.last_synced || null,
      timestamp: new Date().toISOString()
    })
  };
}
