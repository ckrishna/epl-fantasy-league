import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

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

async function storePlayerGameweekData(players, gameweeks) {
  logger.info('Starting player gameweek data fetch', { player_count: players.length });
  
  let processedCount = 0;
  let itemsStored = 0;
  
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    
    if (i % 100 === 0) {
      logger.info(`Processing player ${i}/${players.length}`);
    }
    
    try {
      const playerRes = await fetch(`${FPL_API}/element-summary/${player.id}/`);
      if (!playerRes.ok) continue;
      
      const playerData = await playerRes.json();
      
      for (const gwHistEntry of playerData.history) {
        const item = {
          season_event: `${SEASON}#${gwHistEntry.round}`,
          element_id: player.id,
          name: player.web_name,
          team_id: player.team,
          team_name: player.team_name || '',
          position: player.element_type_name || '',
          value: player.now_cost || 0,
          points: gwHistEntry.total_points || 0,
          minutes: gwHistEntry.minutes || 0,
          goals: gwHistEntry.goals_scored || 0,
          assists: gwHistEntry.assists || 0,
          clean_sheets: gwHistEntry.clean_sheets || 0,
          bonus: gwHistEntry.bonus || 0,
          bps: gwHistEntry.bps || 0,
          yellow_cards: gwHistEntry.yellow_cards || 0,
          red_cards: gwHistEntry.red_cards || 0,
          selected_by_percent: player.selected_by_percent || 0,
          form: player.form || 0,
          last_synced: new Date().toISOString()
        };
        
        try {
          await dynamodb.send(new PutCommand({
            TableName: 'fpl_gameweek_data',
            Item: item
          }));
          itemsStored += 1;
        } catch (err) {
          logger.error(`Failed to store item for player ${player.id}`, err);
        }
      }
      
      processedCount += 1;
      
    } catch (err) {
      logger.error(`Failed to fetch player ${player.id}`, err);
      continue;
    }
    
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  logger.info('Player gameweek data complete', { total_processed: processedCount, items_stored: itemsStored });
}

async function storeFixtures() {
  logger.info('Starting fixtures fetch');
  
  try {
    const fixturesRes = await fetch(`${FPL_API}/fixtures/`);
    if (!fixturesRes.ok) throw new Error(`HTTP ${fixturesRes.status}`);
    
    const fixtures = await fixturesRes.json();
    
    let stored = 0;
    
    for (const fixture of fixtures) {
      if (!fixture.event) continue;
      
      try {
        await dynamodb.send(new PutCommand({
          TableName: 'fpl_fixture_data',
          Item: {
            season_fixture: `${SEASON}#${fixture.id}`,
            event: fixture.event,
            fixture_id: fixture.id,
            team_h: fixture.team_h,
            team_h_name: fixture.team_h_name || '',
            team_a: fixture.team_a,
            team_a_name: fixture.team_a_name || '',
            team_h_score: fixture.team_h_score,
            team_a_score: fixture.team_a_score,
            team_h_difficulty: fixture.team_h_difficulty,
            team_a_difficulty: fixture.team_a_difficulty,
            kickoff_time: fixture.kickoff_time,
            status: fixture.finished ? 'FINISHED' : (fixture.started ? 'STARTED' : 'PENDING'),
            minutes: fixture.minutes || 0,
            last_synced: new Date().toISOString()
          }
        }));
        stored += 1;
      } catch (err) {
        logger.error(`Failed to store fixture ${fixture.id}`, err);
      }
    }
    
    logger.info('Fixtures stored', { count: stored });
    logger.metric('fixtures_stored', stored);
    
  } catch (err) {
    logger.error('Failed to fetch fixtures', err);
  }
}

export async function handler(event) {
  const startTime = Date.now();
  
  logger.info('Starting weekly global stats ingestion');
  
  try {
    const bootstrap = await getBootstrap();
    logger.metric('bootstrap_fetched', 1);
    
    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
    logger.info('Fetched completed gameweeks', { count: completedGWs.length });
    
    // Populate existing tables
    await storePlayerGameweekData(bootstrap.elements, completedGWs);
    await storeFixtures();
    
    const duration = Date.now() - startTime;
    
    logger.info('✅ Weekly global stats complete', {
      duration_ms: duration,
      players: bootstrap.elements.length
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
