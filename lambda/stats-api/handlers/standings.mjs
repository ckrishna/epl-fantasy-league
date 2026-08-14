import { queryLeagueStandings, getActiveGameweek, getCurrentSeason, getLatestStoredGameweek } from '../utils/dynamodb.mjs';

export async function handleStandings(queryParams, corsHeaders) {
  const currentSeason = await getCurrentSeason();
  const requestedSeason = queryParams.season || currentSeason;
  const isHistorical = requestedSeason !== currentSeason;
  // Optional -- see queryLeagueStandings for why omitting it is safe (every row today
  // predates league_id and passes through unfiltered). Lets the frontend disambiguate
  // once a second league shares a season, without breaking any caller that doesn't pass it.
  const leagueId = queryParams.league_id || null;

  // Browsing a past season must never consult live FPL data -- that reflects whatever
  // is happening in the real, currently-active season, which has nothing to do with
  // a season someone's looking back at.
  const activeGW = isHistorical
    ? await getLatestStoredGameweek(requestedSeason)
    : await getActiveGameweek();

  let gw = queryParams.gw ? parseInt(queryParams.gw) : activeGW;

  // If no data for this GW, try previous GWs
  let standings = await queryLeagueStandings(gw, requestedSeason, leagueId);

  while ((!standings || standings.length === 0) && gw > 1) {
    gw = gw - 1;
    standings = await queryLeagueStandings(gw, requestedSeason, leagueId);
  }

  // Map and sort
  const standingsData = (standings || [])
    .map(item => ({
      ...item,
      net_points: (item.points_this_week || 0) - (item.transfer_cost || 0)
    }))
    .sort((a, b) => b.total_points - a.total_points);

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      season: requestedSeason,
      gameweek: parseInt(gw),
      active_gameweek: activeGW,
      standings: standingsData,
      last_updated: standingsData[0]?.last_synced || null,
      timestamp: new Date().toISOString()
    })
  };
}
