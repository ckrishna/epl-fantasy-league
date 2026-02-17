// lambda/fpl-data-ingester/index.mjs
// Comprehensive FPL data ingestion - stores ALL granular data

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const SEASON = '2025/26';
const FPL_API = 'https://fantasy.premierleague.com/api';

// League ID for your league
const LEAGUE_ID = 212889;

// Get all manager IDs from league
async function getLeagueManagers() {
  try {
    const response = await fetch(`${FPL_API}/leagues-classic/${LEAGUE_ID}/standings/`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    // API returns: league.standings.results (not league.results)
    const results = data.standings?.results;
    if (!results || !Array.isArray(results)) {
      throw new Error('Invalid response: missing or invalid standings.results array');
    }
    
    console.log('Found', results.length, 'managers in league');
    
    return results.map(m => ({
      entry_id: m.entry,  // Note: field is 'entry' not 'entry_id'
      manager_name: m.entry_name,
      team_name: m.player_name
    }));
  } catch (err) {
    console.error('Error fetching league managers:', err);
    throw err;
  }
}

// Get bootstrap static data for player info
async function getBootstrapStatic() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`);
    return await response.json();
  } catch (err) {
    console.error('Error fetching bootstrap:', err);
    throw err;
  }
}

// Get manager picks for specific gameweek
async function getManagerPicksForGW(entryId, gw) {
  try {
    const response = await fetch(`${FPL_API}/entry/${entryId}/event/${gw}/picks/`);
    return await response.json();
  } catch (err) {
    console.error(`Error fetching picks for entry ${entryId} GW ${gw}:`, err);
    return null;
  }
}

// Get manager's full event history (for chip usage, transfers)
async function getManagerEventHistory(entryId) {
  try {
    const response = await fetch(`${FPL_API}/entry/${entryId}/history/`);
    return await response.json();
  } catch (err) {
    console.error(`Error fetching history for entry ${entryId}:`, err);
    return null;
  }
}

// Store manager gameweek summary
async function storeGameweekSummary(manager, picksData, gw) {
  const entryHistory = picksData.entry_history;
  
  const item = {
    season_entry: `${SEASON}#${manager.entry_id}`,
    gameweek: gw.id,
    entry_id: manager.entry_id,
    season: SEASON,
    
    manager_name: manager.manager_name,
    team_name: manager.team_name,
    
    points_this_week: entryHistory.points || 0,
    points_gross: entryHistory.points || 0,
    transfer_cost: entryHistory.event_transfers_cost || 0,
    points_total: entryHistory.total_points || 0,
    
    transfers_made: entryHistory.event_transfers || 0,
    transfers_remaining: entryHistory.transfers_left || 0,
    active_chip: entryHistory.active_chip || null,
    
    bank: (entryHistory.bank || 0) / 10,
    value: (entryHistory.value || 0) / 10,
    
    gw_winner: false,
    
    last_synced: new Date().toISOString(),
    data_version: 'v1'
  };
  
  try {
    await dynamodb.send(new PutCommand({
      TableName: 'fpl_entry_gameweek',
      Item: item
    }));
    console.log(`Stored gameweek summary for ${manager.manager_name} GW ${gw.id}`);
  } catch (err) {
    console.error(`Error storing gameweek summary:`, err);
  }
}

// Store individual picks for the gameweek
async function storePicks(manager, picksData, playerMap, gw) {
  const picks = picksData.picks;
  const batch = [];
  
  for (const pick of picks) {
    const player = playerMap[pick.element];
    
    const item = {
      season_entry_gw: `${SEASON}#${manager.entry_id}#${gw.id}`,
      position_player: `${pick.position}#${pick.element}`,
      
      season: SEASON,
      entry_id: manager.entry_id,
      gameweek: gw.id,
      
      player_id: pick.element,
      player_name: player ? player.web_name : 'Unknown',
      player_position: player ? player.element_type : null,
      player_team: player ? player.team : null,
      
      squad_position: pick.position,
      squad_position_name: getPositionName(pick.position),
      
      is_captain: pick.is_captain || false,
      is_vice_captain: pick.is_vice_captain || false,
      multiplier: pick.multiplier || 1,
      
      points: pick.points || 0,
      is_starter: pick.position <= 11,
      is_bench: pick.position > 11,
      
      player_form: player ? player.form : null,
      player_status: player ? player.status : null,
      
      last_synced: new Date().toISOString()
    };
    
    // Add GSI attributes
    item.player_gameweek = `${pick.element}#${SEASON}#${gw.id}`;
    item.season_entry_position = `${SEASON}#${manager.entry_id}#${player?.element_type || 'UNK'}`;
    
    batch.push({
      PutRequest: {
        Item: item
      }
    });
  }
  
  // Write in batches of 25 (DynamoDB limit)
  for (let i = 0; i < batch.length; i += 25) {
    try {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          'fpl_entry_picks': batch.slice(i, i + 25)
        }
      }));
    } catch (err) {
      console.error(`Error storing picks batch:`, err);
    }
  }
  
  console.log(`Stored ${picks.length} picks for ${manager.manager_name} GW ${gw.id}`);
}

// Store transfer history
async function storeTransfers(manager, entryHistory, playerMap, gw) {
  if (!entryHistory.transfers || entryHistory.transfers.length === 0) {
    return;
  }
  
  const batch = [];
  
  for (let i = 0; i < entryHistory.transfers.length; i++) {
    const transfer = entryHistory.transfers[i];
    const playerOut = playerMap[transfer.element_out];
    const playerIn = playerMap[transfer.element_in];
    
    const item = {
      season_entry: `${SEASON}#${manager.entry_id}`,
      gw_transfer_id: `${gw.id}#${i + 1}`,
      
      season: SEASON,
      entry_id: manager.entry_id,
      gameweek: gw.id,
      transfer_sequence: i + 1,
      
      player_out_id: transfer.element_out,
      player_out_name: playerOut ? playerOut.web_name : 'Unknown',
      player_out_position: playerOut ? playerOut.element_type : null,
      player_out_team: playerOut ? playerOut.team : null,
      
      player_in_id: transfer.element_in,
      player_in_name: playerIn ? playerIn.web_name : 'Unknown',
      player_in_position: playerIn ? playerIn.element_type : null,
      player_in_team: playerIn ? playerIn.team : null,
      
      transfer_cost: transfer.event_transfers_cost || 0,
      transfer_cost_penalty: (transfer.event_transfers_cost || 0) > 0,
      
      value_out: (transfer.value_out || 0) / 10,
      value_in: (transfer.value_in || 0) / 10,
      
      reason: 'auto', // Can be enhanced later
      season_transfers_used: entryHistory.transfers_made || 0,
      
      last_synced: new Date().toISOString()
    };
    
    // Add GSI attribute
    item.entry_gameweek_transfers = `${manager.entry_id}#${gw.id}`;
    
    batch.push({
      PutRequest: {
        Item: item
      }
    });
  }
  
  // Write in batches
  for (let i = 0; i < batch.length; i += 25) {
    try {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          'fpl_entry_transfers': batch.slice(i, i + 25)
        }
      }));
    } catch (err) {
      console.error(`Error storing transfers batch:`, err);
    }
  }
  
  console.log(`Stored ${entryHistory.transfers.length} transfers for ${manager.manager_name} GW ${gw.id}`);
}

// Store chip usage
async function storeChips(manager, eventHistory, gw) {
  if (!eventHistory || !eventHistory.chips) {
    return;
  }
  
  // Find if a chip was used this gameweek
  const gwEvent = eventHistory.current.find(e => e.event === gw.id);
  if (!gwEvent || !gwEvent.active_chip) {
    return;
  }
  
  const chipName = gwEvent.active_chip;
  
  const item = {
    season_entry: `${SEASON}#${manager.entry_id}`,
    gw_chip: `${gw.id}#${chipName}`,
    
    season: SEASON,
    entry_id: manager.entry_id,
    gameweek: gw.id,
    chip_name: chipName,
    
    points_that_week: gwEvent.points || 0,
    points_week_after: null, // Will be calculated later
    points_week_after_2: null,
    
    transfers_made: gwEvent.event_transfers || 0,
    avg_sell_price: null,
    avg_buy_price: null,
    
    effectiveness_score: null, // Calculate post-season
    timing_notes: gw.id <= 10 ? 'early_season' : gw.id <= 20 ? 'mid_season' : 'late_season',
    
    last_synced: new Date().toISOString()
  };
  
  try {
    await dynamodb.send(new PutCommand({
      TableName: 'fpl_entry_chips',
      Item: item
    }));
    console.log(`Stored chip usage for ${manager.manager_name} GW ${gw.id}: ${chipName}`);
  } catch (err) {
    console.error(`Error storing chip:`, err);
  }
}

// Calculate and store GW winners
async function calculateAndStoreWinners(gw, allManagersData) {
  // Find highest net_points for this GW
  let maxNetPoints = -1;
  const winners = [];
  
  for (const [entryId, gwData] of Object.entries(allManagersData)) {
    const netPoints = (gwData.points_gross || gwData.points_this_week) - gwData.transfer_cost;
    
    if (netPoints > maxNetPoints) {
      maxNetPoints = netPoints;
      winners.length = 0;
      winners.push(gwData);
    } else if (netPoints === maxNetPoints) {
      winners.push(gwData);
    }
  }
  
  // Store in cache
  const cacheItem = {
    season: SEASON,
    gameweek: gw.id,
    winners: winners.map(w => ({
      entry_id: w.entry_id,
      manager_name: w.manager_name,
      team_name: w.team_name,
      net_points: w.points_this_week - w.transfer_cost,
      gross_points: w.points_this_week,
      transfer_cost: w.transfer_cost,
      rank: 1
    })),
    is_current: false,
    last_synced: new Date().toISOString(),
    data_version: 'v1'
  };
  
  try {
    await dynamodb.send(new PutCommand({
      TableName: 'gw-winners-cache',
      Item: cacheItem
    }));
    console.log(`Stored ${winners.length} winner(s) for GW ${gw.id}`);
  } catch (err) {
    console.error(`Error storing winners cache:`, err);
  }
}

// Helper function to get position name
function getPositionName(pos) {
  const positions = {
    1: 'GK',
    2: 'DEF',
    3: 'MID',
    4: 'FWD'
  };
  return positions[pos] || 'UNK';
}

// Main handler
export async function handler(event) {
  console.log('Starting comprehensive FPL data ingestion...');
  
  try {
    // Get bootstrap data (players, gameweeks)
    console.log('Fetching bootstrap data...');
    const bootstrap = await getBootstrapStatic();
    const playerMap = {};
    for (const player of bootstrap.elements) {
      playerMap[player.id] = player;
    }
    const gameweeks = bootstrap.events;
    
    // Get all managers
    console.log('Fetching league managers...');
    const managers = await getLeagueManagers();
    console.log(`Found ${managers.length} managers`);
    
    // Process each manager
    for (const manager of managers) {
      console.log(`\nProcessing manager: ${manager.manager_name}`);
      
      const allGWData = {};
      
      // Get full history for transfers/chips
      const eventHistory = await getManagerEventHistory(manager.entry_id);
      
      // Get active gameweek from bootstrap
      const activeGW = bootstrap.events.find(e => e.is_current)?.id || 26;
      console.log(`Active GW: ${activeGW}`);
      
      // Only fetch current GW and previous GW (already locked)
      const gwsToFetch = gameweeks.filter(gw => gw.id >= activeGW - 1 && gw.id <= activeGW);
      console.log(`Fetching ${gwsToFetch.length} gameweeks: ${gwsToFetch.map(g => g.id).join(', ')}`);
        
  // Process each gameweek
      for (const gw of gwsToFetch) {
        console.log(`  GW ${gw.id}...`);
        
        const picksData = await getManagerPicksForGW(manager.entry_id, gw.id);
        if (!picksData || !picksData.entry_history) {
          console.log(`  No data for GW ${gw.id}, skipping`);
          continue;
        }
        // Store gameweek summary
        await storeGameweekSummary(manager, picksData, gw);
        
        // Store picks
        await storePicks(manager, picksData, playerMap, gw);
        
        // Store transfers
        const gwEventHistory = eventHistory?.current?.find(e => e.event === gw.id);
        if (gwEventHistory?.transfers) {
          await storeTransfers(manager, gwEventHistory, playerMap, gw);
        }
        
        // Store chips
        if (gwEventHistory?.active_chip) {
          await storeChips(manager, eventHistory, gw);
        }
        
        // Collect for winner calculation
        allGWData[manager.entry_id] = {
          entry_id: manager.entry_id,
          manager_name: manager.manager_name,
          team_name: manager.team_name,
          points_this_week: picksData.entry_history.points || 0,
          transfer_cost: picksData.entry_history.event_transfers_cost || 0
        };
        
        // Rate limit: 1 request per second
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Calculate winners for each GW
      for (const gw of gameweeks) {
        // Re-fetch all manager data for this GW to calculate winners
        // This is simplified; in production you'd query what you just stored
      }
    }
    
    console.log('\n✅ Data ingestion complete!');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Data ingestion completed',
        timestamp: new Date().toISOString()
      })
    };
    
  } catch (err) {
    console.error('Fatal error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message
      })
    };
  }
}
