import { queryLeagueStandings, getActiveGameweek, getCurrentSeason, getLatestStoredGameweek } from '../utils/dynamodb.mjs';
import { getMoneyConfigForLeagueId } from '../utils/group-seasons.mjs';

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

  // Real-money prize-pool config, opt-in per league (see getMoneyConfigForLeagueId's
  // own comment) -- only resolved for the CURRENT season. A past season's standings
  // are final/settled, but the money feature is specifically a live projection ("if
  // today's standings held"), which has no meaning once you're looking at history;
  // skipping the lookup there also avoids a pointless extra DynamoDB round-trip on
  // every historical-season request. Wrapped defensively -- this is a purely additive
  // feature that most leagues will never have configured; a DynamoDB hiccup resolving
  // it should degrade to "no money data" (same as the common unconfigured case),
  // never take down the whole standings response it's riding along on.
  let moneyConfig = null;
  if (!isHistorical && leagueId) {
    try {
      moneyConfig = await getMoneyConfigForLeagueId(leagueId);
    } catch (err) {
      console.error('getMoneyConfigForLeagueId failed:', err);
    }
  }

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
      money_config: moneyConfig,
      last_updated: standingsData[0]?.last_synced || null,
      timestamp: new Date().toISOString()
    })
  };
}
