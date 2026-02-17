import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const SEASON = '2025/26';
const FPL_API = 'https://fantasy.premierleague.com/api';

const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), msg, ...data })),
  error: (msg, err = {}) => console.error(JSON.stringify({ level: 'ERROR', timestamp: new Date().toISOString(), msg, error: err.message })),
  metric: (name, value, unit = '') => console.log(JSON.stringify({ level: 'METRIC', timestamp: new Date().toISOString(), metric: name, value, unit }))
};

async function getBootstrap() {
  const response = await fetch(`${FPL_API}/bootstrap-static/`);
  return await response.json();
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function storePlayerGlobalStats(players, gameweeks) {
  logger.info('Starting player global stats fetch', { player_count: players.length, gw_count: gameweeks.length });
  
  const playerChunks = chunk(players, 50);
  let processedCount = 0;
  let itemsStored = 0;
  
  for (let chunkIdx = 0; chunkIdx < playerChunks.length; chunkIdx++) {
    const playerChunk = playerChunks[chunkIdx];
    logger.info(`Processing player chunk ${chunkIdx + 1}/${playerChunks.length}`, { 
      players_in_chunk: playerChunk.length 
    });
    
    const batch = [];
    const seenKeys = new Set(); // Track what we've added to avoid duplicates
    
    for (const player of playerChunk) {
      try {
        const playerRes = await fetch(`${FPL_API}/element-summary/${player.id}/`);
        if (!playerRes.ok) continue;
        
        const playerData = await playerRes.json();
        
        for (const gwHistEntry of playerData.history) {
          // Create unique key
          const key = `${SEASON}#${player.id}#${gwHistEntry.round}`;
          
          // Skip if we've already added this key
          if (seenKeys.has(key)) {
            logger.metric('duplicate_skipped', 1);
            continue;
          }
          
          seenKeys.add(key);
          
          const item = {
            season_player_gw: key,
            player_id: player.id,
            season: SEASON,
            gameweek: gwHistEntry.round,
            player_name: player.web_name,
            player_position: player.element_type,
            player_team: player.team,
            global_points: gwHistEntry.total_points || 0,
            global_minutes: gwHistEntry.minutes || 0,
            global_goals: gwHistEntry.goals_scored || 0,
            global_assists: gwHistEntry.assists || 0,
            global_clean_sheets: gwHistEntry.clean_sheets || 0,
            global_ownership: player.selected_by_percent || 0,
            global_form: player.form || 0,
            opponent_team: gwHistEntry.opponent_team || 0,
            is_home: gwHistEntry.was_home || false,
            last_synced: new Date().toISOString()
          };
          
          batch.push({
            PutRequest: { Item: item }
          });
          
          itemsStored += 1;
        }
        
        processedCount += 1;
        
      } catch (err) {
        logger.error(`Failed to fetch player ${player.id}`, err);
        continue;
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Write batches in groups of 25 (DynamoDB limit)
    const writeBatches = chunk(batch, 25);
    for (const writeBatch of writeBatches) {
      try {
        await dynamodb.send(new BatchWriteCommand({
          RequestItems: {
            'fpl_player_gameweek_stats': writeBatch
          }
        }));
      } catch (err) {
        logger.error('Failed to write player stats batch', err);
      }
    }
    
    logger.metric('players_processed', processedCount);
  }
  
  logger.info('Player global stats complete', { total_processed: processedCount, items_stored: itemsStored });
}

export async function handler(event) {
  const startTime = Date.now();
  
  logger.info('Starting weekly global stats ingestion', { run_id: event.requestContext?.requestId || 'scheduled' });
  
  try {
    const bootstrap = await getBootstrap();
    logger.metric('bootstrap_fetched', 1);
    
    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
    logger.info('Fetched completed gameweeks', { count: completedGWs.length, gws: completedGWs });
    
    await storePlayerGlobalStats(bootstrap.elements, completedGWs);
    
    const duration = Date.now() - startTime;
    
    logger.info('✅ Weekly global stats complete', {
      duration_ms: duration,
      players: bootstrap.elements.length,
      gameweeks: completedGWs.length
    });
    
    logger.metric('weekly_ingestion_duration', duration, 'ms');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Weekly global stats ingestion completed',
        duration_ms: duration
      })
    };
    
  } catch (err) {
    logger.error('Fatal error in weekly ingestion', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
}
