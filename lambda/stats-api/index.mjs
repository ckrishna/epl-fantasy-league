// lambda/stats-api/index.mjs - Updated with comprehensive data queries
// Queries all 5 tables for rich data responses

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const SEASON = '2025/26';
const FPL_API = 'https://fantasy.premierleague.com/api';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Get current active gameweek from FPL API
async function getActiveGameweek() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`);
    const data = await response.json();
    const current = data.events.find(e => e.is_current);
    return current ? current.id : null;
  } catch (err) {
    console.error('Error fetching active gameweek:', err);
    return null;
  }
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


// GET /standings - Show standings for requested GW or active GW
    if (path.includes('/standings')) {
      try {
        // Get active gameweek from FPL API
        const bootstrapRes = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
        const bootstrap = await bootstrapRes.json();
        const activeGW = bootstrap.events.find(e => e.is_current)?.id;
        
        // Use requested GW or active GW
        const gwToFetch = queryParams.gw ? parseInt(queryParams.gw) : activeGW;
        
        console.log(`Fetching standings for GW ${gwToFetch} (active: ${activeGW})`);
        
        const result = await dynamodb.send(new ScanCommand({
          TableName: 'fpl_entry_gameweek',
          FilterExpression: 'gameweek = :gw',
          ExpressionAttributeValues: {
            ':gw': gwToFetch
          }
        }));

        const standings = (result.Items || []).sort((a, b) => {
          const netA = (a.points_this_week || 0) - (a.transfer_cost || 0);
          const netB = (b.points_this_week || 0) - (b.transfer_cost || 0);
          return netB - netA;
        });

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            gameweek: gwToFetch,
            active_gameweek: activeGW,
            standings: standings,
            last_updated: standings[0]?.last_synced || null,
            timestamp: new Date().toISOString()
          })
        };
      } catch (err) {
        console.error('Error fetching standings:', err);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ error: err.message })
        };
      }
    }

    // GET /winners - Query from gw-winners-cache (zero external API calls!)
    if (path.includes('/winners')) {
      console.log('Fetching GW winners from cache');
      
      // Get active gameweek (one API call for reference only)
      const activeGW = await getActiveGameweek();
      
      // Query all winners from cache
      const result = await dynamodb.send(new ScanCommand({
        TableName: 'gw-winners-cache',
        FilterExpression: 'season = :season',
        ExpressionAttributeValues: {
          ':season': SEASON
        }
      }));

      const winners = (result.Items || []).sort((a, b) => b.gameweek - a.gameweek);
      const lastUpdated = winners.length > 0 ? winners[0].last_synced : null;

      console.log(`Found ${winners.length} gameweeks with winner data`);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          active_gameweek: activeGW,
          last_updated: lastUpdated,
          finished_gameweeks: winners.map(w => ({
            gameweek: w.gameweek,
            winners: w.winners,
            winner_count: w.winners.length
          })),
          total_gameweeks_completed: winners.length,
          timestamp: new Date().toISOString()
        })
      };
    }

    // GET /manager/{entry_id}/stats - Manager career stats
    if (path.includes('/manager/') && path.includes('/stats')) {
      const entryId = path.split('/')[3];
      console.log(`Fetching stats for manager ${entryId}`);
      
      // Query gameweeks for this manager
      const gwResult = await dynamodb.send(new QueryCommand({
        TableName: 'fpl_entry_gameweek',
        KeyConditionExpression: 'season_entry = :se',
        ExpressionAttributeValues: {
          ':se': `${SEASON}#${entryId}`
        }
      }));

      const gameweeks = gwResult.Items || [];
      
      // Calculate stats
      const stats = {
        entry_id: parseInt(entryId),
        total_points: gameweeks.reduce((sum, gw) => sum + gw.points_total, 0),
        best_gw: Math.max(...gameweeks.map(gw => gw.points_this_week)),
        worst_gw: Math.min(...gameweeks.map(gw => gw.points_this_week)),
        avg_gw_points: (gameweeks.reduce((sum, gw) => sum + gw.points_this_week, 0) / gameweeks.length).toFixed(1),
        gw_wins: gameweeks.filter(gw => gw.gw_winner).length,
        total_transfers: gameweeks.reduce((sum, gw) => sum + gw.transfers_made, 0),
        total_transfer_cost: gameweeks.reduce((sum, gw) => sum + gw.transfer_cost, 0),
        gameweeks: gameweeks.length,
        best_rank: Math.min(...gameweeks.map(gw => gw.rank)),
        worst_rank: Math.max(...gameweeks.map(gw => gw.rank))
      };

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          stats: stats,
          last_updated: gameweeks[0]?.last_synced || null,
          timestamp: new Date().toISOString()
        })
      };
    }

    // GET /picks/{entry_id}/gw/{gw} - Get specific gameweek picks
    if (path.includes('/picks/') && path.includes('/gw/')) {
      const pathParts = path.split('/');
      const entryId = pathParts[2];
      const gw = pathParts[4];
      
      console.log(`Fetching picks for manager ${entryId} GW ${gw}`);
      
      const result = await dynamodb.send(new QueryCommand({
        TableName: 'fpl_entry_picks',
        KeyConditionExpression: 'season_entry_gw = :sew',
        ExpressionAttributeValues: {
          ':sew': `${SEASON}#${entryId}#${gw}`
        }
      }));

      const picks = result.Items || [];
      
      // Separate starters and bench
      const starters = picks.filter(p => p.is_starter).sort((a, b) => a.squad_position - b.squad_position);
      const bench = picks.filter(p => p.is_bench);
      
      // Calculate totals
      const totalPoints = picks.reduce((sum, p) => sum + p.points, 0);
      const captainPick = picks.find(p => p.is_captain);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          entry_id: parseInt(entryId),
          gameweek: parseInt(gw),
          starters: starters,
          bench: bench,
          captain: captainPick,
          total_points: totalPoints,
          timestamp: new Date().toISOString()
        })
      };
    }

    // GET /transfers/{entry_id} - Transfer history
    if (path.includes('/transfers/')) {
      const entryId = path.split('/')[2];
      console.log(`Fetching transfers for manager ${entryId}`);
      
      const result = await dynamodb.send(new QueryCommand({
        TableName: 'fpl_entry_transfers',
        KeyConditionExpression: 'season_entry = :se',
        ExpressionAttributeValues: {
          ':se': `${SEASON}#${entryId}`
        }
      }));

      const transfers = result.Items || [];

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          entry_id: parseInt(entryId),
          transfers: transfers,
          total_transfers: transfers.length,
          total_cost: transfers.reduce((sum, t) => sum + t.transfer_cost, 0),
          timestamp: new Date().toISOString()
        })
      };
    }

    // GET /chips/{entry_id} - Chip usage history
    if (path.includes('/chips/')) {
      const entryId = path.split('/')[2];
      console.log(`Fetching chips for manager ${entryId}`);
      
      const result = await dynamodb.send(new QueryCommand({
        TableName: 'fpl_entry_chips',
        KeyConditionExpression: 'season_entry = :se',
        ExpressionAttributeValues: {
          ':se': `${SEASON}#${entryId}`
        }
      }));

      const chips = result.Items || [];

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          entry_id: parseInt(entryId),
          chips: chips,
          total_chips_used: chips.length,
          timestamp: new Date().toISOString()
        })
      };
    }

// Calculate winners for all completed gameweeks
    console.log('\nCalculating and caching winners...');
    const gwsWithData = {};
    
    // Query all gameweeks from fpl_entry_gameweek
    const allGWResult = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek'
    }));
    
    // Group by gameweek and find winner
    for (const item of allGWResult.Items || []) {
      if (!gwsWithData[item.gameweek]) {
        gwsWithData[item.gameweek] = [];
      }
      gwsWithData[item.gameweek].push(item);
    }
    
    // For each GW, find winner and cache it
    for (const [gw, managers] of Object.entries(gwsWithData)) {
      const maxNetPoints = Math.max(...managers.map(m => m.points_this_week - m.transfer_cost));
      const winners = managers.filter(m => m.points_this_week - m.transfer_cost === maxNetPoints);
      
      await dynamodb.send(new PutCommand({
        TableName: 'gw-winners-cache',
        Item: {
          season: SEASON,
          gameweek: parseInt(gw),
          winners: winners.map(w => ({
            entry_id: w.entry_id,
            manager_name: w.manager_name,
            team_name: w.team_name,
            net_points: w.points_this_week - w.transfer_cost,
            gross_points: w.points_this_week,
            transfer_cost: w.transfer_cost
          })),
          is_current: parseInt(gw) === activeGW,
          last_synced: new Date().toISOString()
        }
      }));
    }
    console.log(`Cached winners for ${Object.keys(gwsWithData).length} gameweeks`);

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
