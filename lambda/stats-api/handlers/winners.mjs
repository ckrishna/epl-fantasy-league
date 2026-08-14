import { getGWWinners, getCurrentSeason, getActiveGameweek, getLatestStoredGameweek } from '../utils/dynamodb.mjs';

export async function handleWinners(queryParams, corsHeaders) {
  const currentSeason = await getCurrentSeason();
  const requestedSeason = queryParams?.season || currentSeason;
  const isHistorical = requestedSeason !== currentSeason;
  // See handleStandings for why this is optional and safe to omit.
  const leagueId = queryParams?.league_id || null;

  const winners = (await getGWWinners(requestedSeason, leagueId))
    .sort((a, b) => b.gameweek - a.gameweek)
    .map(w => ({
      gameweek: w.gameweek,
      winners: w.winners || [],
      winner_count: (w.winners || []).length,
      season: w.season
    }));

  // Derive the active gameweek from the winners data we actually have (the highest
  // gameweek present); only fall back to a live lookup if we have no winners cached
  // yet at all -- and even then, never consult live FPL data for a past season, since
  // that reflects the real, currently-active season, not the one being browsed.
  const activeGameweek = winners.length > 0
    ? Math.max(...winners.map(w => w.gameweek))
    : isHistorical
      ? await getLatestStoredGameweek(requestedSeason)
      : await getActiveGameweek();

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      season: requestedSeason,
      active_gameweek: activeGameweek,
      finished_gameweeks: winners,
      total_gameweeks_completed: winners.length,
      last_updated: winners[0]?.last_synced || null,
      timestamp: new Date().toISOString()
    })
  };
}
