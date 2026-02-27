import { queryLeagueStandings, getActiveGameweek } from '../utils/dynamodb.mjs';

export async function handleStandings(queryParams, corsHeaders) {
  const activeGW = await getActiveGameweek();
  let gw = queryParams.gw ? parseInt(queryParams.gw) : activeGW;
  
  // If no data for this GW, try previous GWs
  let standings = await queryLeagueStandings(gw);
  
  while ((!standings || standings.length === 0) && gw > 1) {
    gw = gw - 1;
    standings = await queryLeagueStandings(gw);
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
      gameweek: parseInt(gw),
      active_gameweek: activeGW,
      standings: standingsData,
      last_updated: standingsData[0]?.last_synced || null,
      timestamp: new Date().toISOString()
    })
  };
}
