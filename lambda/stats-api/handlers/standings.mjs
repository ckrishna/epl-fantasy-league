import { queryLeagueStandings, getActiveGameweek } from '../utils/dynamodb.mjs';

export async function handleStandings(queryParams, corsHeaders) {
  const gw = queryParams.gw ? parseInt(queryParams.gw) : 25;
  const activeGW = await getActiveGameweek();
  
  const standings = (await queryLeagueStandings(gw))
    .map(item => ({
      ...item,
      net_points: (item.points_this_week || 0) - (item.transfer_cost || 0)
    }))
    .sort((a, b) => b.net_points - a.net_points);

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      gameweek: parseInt(gw),
      active_gameweek: activeGW,
      standings,
      last_updated: standings[0]?.last_synced || null,
      timestamp: new Date().toISOString()
    })
  };
}
