import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const FPL_API = 'https://fantasy.premierleague.com/api';

const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), msg, ...data })),
  error: (msg, err = {}) => console.error(JSON.stringify({ level: 'ERROR', timestamp: new Date().toISOString(), msg, error: err.message })),
  metric: (name, value, unit = '') => console.log(JSON.stringify({ level: 'METRIC', timestamp: new Date().toISOString(), metric: name, value, unit }))
};

// Writes one row per invocation to ingestion_runs -- see fpl-bootstrap/index.mjs for
// the full rationale. `trigger` is derived from the Lambda event shape: EventBridge's
// scheduled invocations always carry `source: "aws.events"` -- UNLESS the rule
// specifies a custom Input JSON (as the fixtures-only daily rule does, to pass the
// `mode` flag below), in which case that custom JSON *completely replaces* the event
// EventBridge would otherwise send, `source` included. The fixtures-only rule's Input
// must therefore explicitly include `"source": "aws.events"` itself, or every one of
// its runs would silently misreport as `trigger: "manual"` in ingestion_runs.
// See scripts/automate_fpl_fixtures_daily.sh for where that's set.
async function recordIngestionRun({ event, startedAt, status, summary, errorMessage }) {
  try {
    await dynamodb.send(new PutCommand({
      TableName: 'ingestion_runs',
      Item: {
        function_name: 'fpl-global-stats-weekly',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - new Date(startedAt).getTime(),
        status,
        trigger: event?.source === 'aws.events' ? 'scheduled' : 'manual',
        summary: summary ?? {},
        error_message: errorMessage ?? null
      }
    }));
  } catch (err) {
    logger.error('Failed to record ingestion_runs entry', err);
  }
}

async function getBootstrap() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    logger.info('Bootstrap fetched', { teams: data.teams?.length, elements: data.elements?.length });
    return data;
  } catch (err) {
    logger.error('Failed to fetch bootstrap', err);
    throw err;
  }
}

async function getSeasonId() {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'seasons',
      FilterExpression: '#c = :curr',
      ExpressionAttributeNames: { '#c': 'current' },
      ExpressionAttributeValues: { ':curr': true }
    }));
    
    if (result.Items && result.Items.length > 0) {
      return result.Items[0].season_id;
    }
    throw new Error('No current season found');
  } catch (err) {
    logger.error('Failed to get season_id', err);
    throw err;
  }
}

async function storePlayerGameweekData(players, bootstrap, seasonId) {
  // Build lookup maps from bootstrap
  const teamMap = {};
  for (const team of bootstrap.teams) {
    teamMap[team.id] = team.name;
  }

  const positionMap = {};
  for (const pos of bootstrap.element_types) {
    positionMap[pos.id] = pos.singular_name;
  }

  logger.info('Starting player gameweek data fetch', { player_count: players.length, season_id: seasonId });
  
  let processedCount = 0;
  let itemsStored = 0;
  let errorCount = 0;
  
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
          season_id: seasonId,
          gameweek_player: `${gwHistEntry.round}#${player.id}`,
          player_id: player.id,
          gameweek: gwHistEntry.round,
          name: player.web_name,
          team_id: player.team,
          team_name: teamMap[player.team] || '',
          position: positionMap[player.element_type] || '',
          now_cost: player.now_cost || 0,
          total_points: gwHistEntry.total_points || 0,
          minutes: gwHistEntry.minutes || 0,
          goals_scored: gwHistEntry.goals_scored || 0,
          assists: gwHistEntry.assists || 0,
          clean_sheets: gwHistEntry.clean_sheets || 0,
          goals_conceded: gwHistEntry.goals_conceded || 0,
          own_goals: gwHistEntry.own_goals || 0,
          penalties_saved: gwHistEntry.penalties_saved || 0,
          penalties_missed: gwHistEntry.penalties_missed || 0,
          yellow_cards: gwHistEntry.yellow_cards || 0,
          red_cards: gwHistEntry.red_cards || 0,
          saves: gwHistEntry.saves || 0,
          bonus: gwHistEntry.bonus || 0,
          bps: gwHistEntry.bps || 0,
          influence: gwHistEntry.influence || '0',
          creativity: gwHistEntry.creativity || '0',
          threat: gwHistEntry.threat || '0',
          ict_index: gwHistEntry.ict_index || '0',
          clearances_blocks_interceptions: gwHistEntry.clearances_blocks_interceptions || 0,
          recoveries: gwHistEntry.recoveries || 0,
          tackles: gwHistEntry.tackles || 0,
          defensive_contribution: gwHistEntry.defensive_contribution || 0,
          starts: gwHistEntry.starts || 0,
          expected_goals: gwHistEntry.expected_goals || '0',
          expected_assists: gwHistEntry.expected_assists || '0',
          expected_goal_involvements: gwHistEntry.expected_goal_involvements || '0',
          expected_goals_conceded: gwHistEntry.expected_goals_conceded || '0',
          selected_by_percent: player.selected_by_percent || 0,
          form: player.form || 0,
          fixture: gwHistEntry.fixture || 0,
          opponent_team: gwHistEntry.opponent_team || 0,
          was_home: gwHistEntry.was_home || false,
          modified: gwHistEntry.modified || false,
          last_synced: new Date().toISOString()
        };
        
        try {
          await dynamodb.send(new PutCommand({
            TableName: 'player_event_stats',
            Item: item
          }));
          itemsStored += 1;
        } catch (err) {
          if (!err.message.includes('duplicate')) {
            logger.error(`Failed to store item for player ${player.id} GW ${gwHistEntry.round}`, err);
            errorCount += 1;
          }
        }
      }
      
      processedCount += 1;
      
    } catch (err) {
      logger.error(`Failed to fetch player ${player.id}`, err);
      errorCount += 1;
      continue;
    }
    
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  logger.info('Player gameweek data complete', { total_processed: processedCount, items_stored: itemsStored, errors: errorCount });
  logger.metric('player_event_stats_stored', itemsStored);
  return { processedCount, itemsStored, errorCount };
}

async function storeFixtures(bootstrap, seasonId) {
  // Build team lookup
  const teamMap = {};
  for (const team of bootstrap.teams) {
    teamMap[team.id] = team.name;
  }

  logger.info('Starting fixtures fetch', { season_id: seasonId });
  
  try {
    const fixturesRes = await fetch(`${FPL_API}/fixtures/`);
    if (!fixturesRes.ok) throw new Error(`HTTP ${fixturesRes.status}`);
    
    const fixtures = await fixturesRes.json();
    
    let stored = 0;
    let errorCount = 0;
    
    for (const fixture of fixtures) {
      if (!fixture.event) continue;
      
      try {
        await dynamodb.send(new PutCommand({
          TableName: 'fpl_fixture_data',
          Item: {
            season_fixture: `${seasonId}#${fixture.id}`,
            event: fixture.event,
            fixture_id: fixture.id,
            season_id: seasonId,
            gameweek: fixture.event,
            team_h: fixture.team_h,
            team_h_name: teamMap[fixture.team_h] || '',
            team_a: fixture.team_a,
            team_a_name: teamMap[fixture.team_a] || '',
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
        errorCount += 1;
      }
    }
    
    logger.info('Fixtures stored', { count: stored, errors: errorCount });
    logger.metric('fixtures_stored', stored);
    return { stored, errorCount };

  } catch (err) {
    logger.error('Failed to fetch fixtures', err);
    return { stored: 0, errorCount: 1 };
  }
}

// `event.mode === 'fixtures-only'` skips storePlayerGameweekData entirely -- added so
// a second, daily EventBridge rule can keep fpl_fixture_data's kickoff_time fresh
// (fixtures sometimes get rescheduled mid-week, and this table previously only
// refreshed on the Tuesday weekly cron, up to a 6-day staleness window) WITHOUT also
// re-running the expensive per-player element-summary loop, which doesn't need
// daily freshness and would otherwise add ~700 extra FPL API calls a day for no
// benefit. The existing Tuesday weekly rule keeps invoking with no mode (or any value
// other than 'fixtures-only'), so it's unaffected and still runs the full job exactly
// as before.
export async function handler(event) {
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();
  const fixturesOnly = event?.mode === 'fixtures-only';

  logger.info(fixturesOnly ? 'Starting fixtures-only refresh' : 'Starting weekly global stats ingestion');

  try {
    // Get current season_id
    const seasonId = await getSeasonId();
    logger.info('Got season_id', { season_id: seasonId });

    // Fetch bootstrap
    const bootstrap = await getBootstrap();
    logger.metric('bootstrap_fetched', 1);

    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
    logger.info('Fetched completed gameweeks', { count: completedGWs.length });

    // Populate tables with new schema
    const playerStatsResult = fixturesOnly
      ? { processedCount: 0, itemsStored: 0, errorCount: 0 }
      : await storePlayerGameweekData(bootstrap.elements, bootstrap, seasonId);
    if (fixturesOnly) {
      logger.info('Skipped player gameweek data fetch (fixtures-only mode)');
    }
    const fixturesResult = await storeFixtures(bootstrap, seasonId);

    const duration = Date.now() - startTime;
    logger.metric('ingestion_duration_ms', duration);

    const summary = {
      mode: fixturesOnly ? 'fixtures-only' : 'full',
      season_id: seasonId,
      player_event_stats_stored: playerStatsResult.itemsStored,
      player_event_stats_errors: playerStatsResult.errorCount,
      fixtures_stored: fixturesResult.stored,
      fixtures_errors: fixturesResult.errorCount
    };

    await recordIngestionRun({ event, startedAt, status: 'success', summary });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Data ingestion completed',
        duration_ms: duration,
        timestamp: new Date().toISOString()
      })
    };

  } catch (err) {
    logger.error('Weekly ingestion failed', err);
    await recordIngestionRun({ event, startedAt, status: 'failure', errorMessage: err.message });
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message,
        timestamp: new Date().toISOString()
      })
    };
  }
}
