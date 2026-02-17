// lambda/stats-api/index.mjs - Updated to fetch from FPL API for accurate net points
// Queries FPL API for GW Winners with transfer cost deductions

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import https from 'https';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const SEASON = '2025/26';
const LEAGUE_ID = 212889;

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Helper to fetch from FPL API
function fetchFPLData(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

export async function handler(event) {
  console.log('Event:', JSON.stringify(event));

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    const path = event.path || event.rawPath || '';
    const queryParams = event.queryStringParameters || {};

    console.log(`Path: ${path}`);

// GET /standings
if (path.includes('/standings')) {
  const gw = queryParams.gw || '25';
  console.log(`Fetching standings for GW ${gw}`);
  
  const result = await dynamodb.send(new QueryCommand({
    TableName: 'fpl_league_standings',
    KeyConditionExpression: 'season_event = :se',
    ExpressionAttributeValues: {
      ':se': `${SEASON}#${gw}`
    }
  }));

  console.log(`Found ${result.Items?.length || 0} standings records`);

  // Remove earnings from response
  const standings = (result.Items || [])
    .sort((a, b) => a.rank - b.rank)
    .map(item => ({
      rank: item.rank,
      manager_id: item.manager_id,
      manager_name: item.manager_name,
      team_name: item.team_name,
      total_points: item.total_points,
      points_this_week: item.points_this_week
      // Removed: earnings
    }));

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      gameweek: parseInt(gw),
      standings: standings
    })
  };
}

// GET /winners - Calculate GW winners from FPL API with NET points (handles ties)
if (path.includes('/winners')) {
  console.log('Fetching GW winners from FPL API');
  
  const winners = [];
  
  // Fetch league data to get list of managers
  let leagueData;
  try {
    leagueData = await fetchFPLData(`https://fantasy.premierleague.com/api/leagues-classic/${LEAGUE_ID}/standings/`);
  } catch (err) {
    console.error('Error fetching league data:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to fetch league data' })
    };
  }

  const managers = leagueData.standings.results.map(m => ({
    id: m.entry,
    name: m.player_name,
    team_name: m.entry_name
  }));

  console.log(`Found ${managers.length} managers in league`);

  // Query each gameweek from 1 to 25
  for (let gw = 1; gw <= 25; gw++) {
    const gwWinners = []; // Array to hold ALL winners for this GW
    let maxNetPoints = -Infinity;

    // Check each manager's score for this GW
    for (const manager of managers) {
      try {
        const picksData = await fetchFPLData(
          `https://fantasy.premierleague.com/api/entry/${manager.id}/event/${gw}/picks/`
        );

        if (picksData.entry_history) {
          const grossPoints = picksData.entry_history.points;
          const transferCost = picksData.entry_history.event_transfers_cost || 0;
          const netPoints = grossPoints - transferCost;

          console.log(`GW ${gw} - ${manager.name}: gross=${grossPoints}, cost=${transferCost}, net=${netPoints}`);

          // Track max points
          if (netPoints > maxNetPoints) {
            maxNetPoints = netPoints;
            gwWinners.length = 0; // Reset array, this is new max
            gwWinners.push({
              manager_name: manager.name,
              team_name: manager.team_name,
              manager_id: manager.id,
              gross_points: grossPoints,
              transfer_cost: transferCost,
              net_points: netPoints
            });
          } else if (netPoints === maxNetPoints && netPoints !== -Infinity) {
            // TIE - add to winners array
            gwWinners.push({
              manager_name: manager.name,
              team_name: manager.team_name,
              manager_id: manager.id,
              gross_points: grossPoints,
              transfer_cost: transferCost,
              net_points: netPoints
            });
            console.log(`GW ${gw}: TIE! Added ${manager.name} with ${netPoints} points`);
          }
        }
      } catch (err) {
        console.log(`Error fetching GW ${gw} for manager ${manager.id}:`, err.message);
      }
    }

    // Add ALL winners for this GW
    if (gwWinners.length > 0) {
      gwWinners.forEach(winner => {
        winners.push({
          gameweek: gw,
          manager_name: winner.manager_name,
          team_name: winner.team_name,
          manager_id: winner.manager_id,
          points: winner.net_points,
          gross_points: winner.gross_points,
          transfer_cost: winner.transfer_cost
        });
      });

      if (gwWinners.length > 1) {
        console.log(`GW ${gw}: ${gwWinners.length} winners tied with ${maxNetPoints} points`);
      } else {
        console.log(`GW ${gw} Winner: ${gwWinners[0].manager_name} with ${gwWinners[0].net_points} points`);
      }
    }
  }

  console.log(`Found ${winners.length} total winners (including ties)`);

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      winners: winners.reverse(),
      total_winners: winners.length,
      total_gameweeks: 25
    })
  };
}

    // GET /players/trending
    if (path.includes('/players/trending')) {
      console.log('Fetching trending players');
      
      const gw = queryParams.gw || '25';
      const limit = parseInt(queryParams.limit) || 10;
      
      const result = await dynamodb.send(new QueryCommand({
        TableName: 'fpl_gameweek_data',
        KeyConditionExpression: 'season_event = :se',
        ExpressionAttributeValues: {
          ':se': `${SEASON}#${gw}`
        },
        Limit: 50
      }));

      const topScorers = (result.Items || [])
        .sort((a, b) => (parseInt(b.points) || 0) - (parseInt(a.points) || 0))
        .slice(0, limit);

      console.log(`Found ${topScorers.length} top scorers`);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          gameweek: parseInt(gw),
          topScorers: topScorers
        })
      };
    }

    // Default 404
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Not found',
        path: path
      })
    };

  } catch (err) {
    console.error('Error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: err.message,
        type: err.name
      })
    };
  }
}
