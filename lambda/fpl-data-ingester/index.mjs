import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const SEASON = '2025/26';
const FPL_API = 'https://fantasy.premierleague.com/api';
const LEAGUE_ID = 212889;

// Structured logging
const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), msg, ...data })),
  error: (msg, err = {}) => console.error(JSON.stringify({ level: 'ERROR', timestamp: new Date().toISOString(), msg, error: err.message })),
  metric: (name, value, unit = '') => console.log(JSON.stringify({ level: 'METRIC', timestamp: new Date().toISOString(), metric: name, value, unit }))
};

async function getLeagueManagers() {
  const startTime = Date.now();
  try {
    const response = await fetch(`${FPL_API}/leagues-classic/${LEAGUE_ID}/standings/`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    
    const results = data.standings?.results;
    if (!results || !Array.isArray(results)) {
      throw new Error('Invalid response: missing standings.results');
    }
    
    const managers = results.map(m => ({
      entry_id: m.entry,
      manager_name: m.entry_name,
      team_name: m.player_name
    }));
    
    logger.info('Fetched league managers', { count: managers.length, duration_ms: Date.now() - startTime });
    return managers;
  } catch (err) {
    logger.error('Failed to fetch league managers', err);
    throw err;
  }
}

async function getBootstrapStatic() {
  const startTime = Date.now();
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    
    logger.info('Fetched bootstrap data', { 
      players: data.elements?.length || 0,
      gameweeks: data.events?.length || 0,
      duration_ms: Date.now() - startTime 
    });
    return data;
  } catch (err) {
    logger.error('Failed to fetch bootstrap', err);
    throw err;
  }
}

async function getManagerPicksForGW(entryId, gw) {
  try {
    const response = await fetch(`${FPL_API}/entry/${entryId}/event/${gw}/picks/`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    logger.error(`Failed to fetch picks for entry ${entryId} GW ${gw}`, err);
    return null;
  }
}

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
    logger.metric('gameweek_summary_stored', 1);
  } catch (err) {
    logger.error('Failed to store gameweek summary', err);
  }
}

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
      is_captain: pick.is_captain || false,
      is_vice_captain: pick.is_vice_captain || false,
      multiplier: pick.multiplier || 1,
      points: pick.points || 0,
      is_starter: pick.position <= 11,
      is_bench: pick.position > 11,
      last_synced: new Date().toISOString()
    };
    
    batch.push({
      PutRequest: { Item: item }
    });
  }
  
  for (let i = 0; i < batch.length; i += 25) {
    try {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          'fpl_entry_picks': batch.slice(i, i + 25)
        }
      }));
    } catch (err) {
      logger.error('Failed to store picks batch', err);
    }
  }
  
  logger.metric('picks_stored', picks.length, 'players');
}

export async function handler(event) {
  const runStartTime = Date.now();
  let apiCallCount = 0;
  let dbWriteCount = 0;
  
  logger.info('Starting nightly FPL data ingestion', { run_id: event.requestContext?.requestId || 'manual' });
  
  try {
    // Fetch bootstrap
    const bootstrap = await getBootstrapStatic();
    apiCallCount += 1;
    
    const playerMap = {};
    for (const player of bootstrap.elements) {
      playerMap[player.id] = player;
    }
    const gameweeks = bootstrap.events;
    
    const activeGW = bootstrap.events.find(e => e.is_current)?.id || 26;
    const gwsToFetch = gameweeks.filter(gw => gw.id >= activeGW - 1 && gw.id <= activeGW);
    
    logger.info('Determined gameweeks to fetch', { 
      active_gw: activeGW, 
      gws_to_fetch: gwsToFetch.map(g => g.id) 
    });
    
    // Fetch managers
    const managers = await getLeagueManagers();
    apiCallCount += 1;
    
    logger.info('Processing managers', { count: managers.length });
    
    // Process each manager
    for (const manager of managers) {
      logger.info(`Starting manager: ${manager.manager_name}`);
      
      for (const gw of gwsToFetch) {
        const picksData = await getManagerPicksForGW(manager.entry_id, gw.id);
        apiCallCount += 1;
        
        if (!picksData || !picksData.entry_history) {
          logger.info(`No data for GW ${gw.id}`, { manager: manager.manager_name });
          continue;
        }
        
        await storeGameweekSummary(manager, picksData, gw);
        dbWriteCount += 1;
        
        await storePicks(manager, picksData, playerMap, gw);
        dbWriteCount += picksData.picks.length;
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Calculate winners
    logger.info('Calculating winners from stored data');
    const allGWResult = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek'
    }));
    
    const gwsWithData = {};
    for (const item of allGWResult.Items || []) {
      if (!gwsWithData[item.gameweek]) {
        gwsWithData[item.gameweek] = [];
      }
      gwsWithData[item.gameweek].push(item);
    }
    
    let winnersCount = 0;
    for (const [gw, managersList] of Object.entries(gwsWithData)) {
      const maxNetPoints = Math.max(...managersList.map(m => m.points_this_week - m.transfer_cost));
      const winners = managersList.filter(m => m.points_this_week - m.transfer_cost === maxNetPoints);
      
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
          is_current: false,
          last_synced: new Date().toISOString()
        }
      }));
      winnersCount += 1;
      dbWriteCount += 1;
    }
    
    logger.info('Winners cached', { gameweeks: winnersCount });
    
    const totalDuration = Date.now() - runStartTime;
    
    logger.info('✅ Data ingestion complete', {
      duration_ms: totalDuration,
      api_calls: apiCallCount,
      db_writes: dbWriteCount,
      managers: managers.length,
      gameweeks: gwsToFetch.length
    });
    
    logger.metric('ingestion_duration', totalDuration, 'ms');
    logger.metric('api_calls_total', apiCallCount, 'requests');
    logger.metric('db_writes_total', dbWriteCount, 'items');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Data ingestion completed',
        timestamp: new Date().toISOString(),
        metrics: {
          duration_ms: totalDuration,
          api_calls: apiCallCount,
          db_writes: dbWriteCount
        }
      })
    };
    
  } catch (err) {
    logger.error('Fatal error in data ingestion', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message
      })
    };
  }
}
