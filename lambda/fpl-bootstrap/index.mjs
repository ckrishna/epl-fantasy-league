import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const FPL_API = 'https://fantasy.premierleague.com/api';

const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), msg, ...data })),
  error: (msg, err = {}) => console.error(JSON.stringify({ level: 'ERROR', timestamp: new Date().toISOString(), msg, error: err.message })),
  metric: (name, value) => console.log(JSON.stringify({ level: 'METRIC', timestamp: new Date().toISOString(), metric: name, value }))
};

async function getBootstrap() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    logger.info('Bootstrap fetched', { teams: data.teams?.length, players: data.elements?.length, events: data.events?.length });
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

async function storeTeams(teams, seasonId) {
  logger.info('Starting teams storage', { count: teams.length, season_id: seasonId });
  
  let stored = 0;
  let errors = 0;
  
  for (const team of teams) {
    try {
      await dynamodb.send(new PutCommand({
        TableName: 'teams',
        Item: {
          season_id: seasonId,
          team_id: team.id,
          name: team.name,
          short_name: team.short_name,
          code: team.code,
          strength: team.strength,
          strength_overall_home: team.strength_overall_home,
          strength_overall_away: team.strength_overall_away,
          strength_attack_home: team.strength_attack_home,
          strength_attack_away: team.strength_attack_away,
          strength_defence_home: team.strength_defence_home,
          strength_defence_away: team.strength_defence_away,
          form: team.form,
          points: team.points,
          position: team.position,
          played: team.played,
          wins: team.win,
          draws: team.draw,
          losses: team.loss,
          unavailable: team.unavailable,
          pulse_id: team.pulse_id,
          team_division: team.team_division,
          last_synced: new Date().toISOString()
        }
      }));
      stored += 1;
    } catch (err) {
      logger.error(`Failed to store team ${team.id}`, err);
      errors += 1;
    }
  }
  
  logger.info('Teams storage complete', { stored, errors });
  logger.metric('teams_stored', stored);
  return { stored, errors };
}

async function storePlayers(players, seasonId) {
  logger.info('Starting players storage', { count: players.length, season_id: seasonId });
  
  let stored = 0;
  let errors = 0;
  
  for (const player of players) {
    try {
      await dynamodb.send(new PutCommand({
        TableName: 'players',
        Item: {
          season_id: seasonId,
          player_id: player.id,
          first_name: player.first_name,
          second_name: player.second_name,
          web_name: player.web_name,
          known_name: player.known_name,
          team_id: player.team,
          element_type: player.element_type,
          now_cost: player.now_cost,
          total_points: player.total_points,
          points_per_game: player.points_per_game,
          form: player.form,
          selected_by_percent: player.selected_by_percent,
          status: player.status,
          removed: player.removed,
          minutes: player.minutes,
          goals_scored: player.goals_scored,
          assists: player.assists,
          clean_sheets: player.clean_sheets,
          goals_conceded: player.goals_conceded,
          own_goals: player.own_goals,
          penalties_saved: player.penalties_saved,
          penalties_missed: player.penalties_missed,
          yellow_cards: player.yellow_cards,
          red_cards: player.red_cards,
          saves: player.saves,
          bonus: player.bonus,
          bps: player.bps,
          influence: player.influence,
          creativity: player.creativity,
          threat: player.threat,
          ict_index: player.ict_index,
          expected_goals: player.expected_goals,
          expected_assists: player.expected_assists,
          expected_goal_involvements: player.expected_goal_involvements,
          expected_goals_conceded: player.expected_goals_conceded,
          photo: player.photo,
          code: player.code,
          opta_code: player.opta_code,
          team_code: player.team_code,
          region: player.region,
          team_join_date: player.team_join_date,
          birth_date: player.birth_date,
          has_temporary_code: player.has_temporary_code,
          dreamteam_count: player.dreamteam_count,
          in_dreamteam: player.in_dreamteam,
          transfers_in: player.transfers_in,
          transfers_out: player.transfers_out,
          value_form: player.value_form,
          value_season: player.value_season,
          last_synced: new Date().toISOString()
        }
      }));
      stored += 1;
    } catch (err) {
      logger.error(`Failed to store player ${player.id}`, err);
      errors += 1;
    }
  }
  
  logger.info('Players storage complete', { stored, errors });
  logger.metric('players_stored', stored);
  return { stored, errors };
}

async function storeElementTypes(elementTypes, seasonId) {
  logger.info('Starting element types storage', { count: elementTypes.length, season_id: seasonId });
  
  let stored = 0;
  let errors = 0;
  
  for (const et of elementTypes) {
    try {
      await dynamodb.send(new PutCommand({
        TableName: 'element_types',
        Item: {
          season_id: seasonId,
          element_type_id: et.id,
          singular_name: et.singular_name,
          singular_name_short: et.singular_name_short,
          plural_name: et.plural_name,
          plural_name_short: et.plural_name_short,
          squad_select: et.squad_select,
          squad_min_select: et.squad_min_select,
          squad_max_select: et.squad_max_select,
          squad_min_play: et.squad_min_play,
          squad_max_play: et.squad_max_play,
          ui_shirt_specific: et.ui_shirt_specific,
          sub_positions_locked: et.sub_positions_locked,
          element_count: et.element_count,
          last_synced: new Date().toISOString()
        }
      }));
      stored += 1;
    } catch (err) {
      logger.error(`Failed to store element type ${et.id}`, err);
      errors += 1;
    }
  }
  
  logger.info('Element types storage complete', { stored, errors });
  logger.metric('element_types_stored', stored);
  return { stored, errors };
}

async function storeEvents(events, seasonId) {
  logger.info('Starting events storage', { count: events.length, season_id: seasonId });
  
  let stored = 0;
  let errors = 0;
  
  for (const event of events) {
    try {
      await dynamodb.send(new PutCommand({
        TableName: 'events',
        Item: {
          season_id: seasonId,
          gameweek_id: event.id,
          name: event.name,
          deadline_time: event.deadline_time,
          deadline_time_epoch: event.deadline_time_epoch,
          deadline_time_game_offset: event.deadline_time_game_offset,
          release_time: event.release_time,
          finished: event.finished,
          released: event.released,
          data_checked: event.data_checked,
          is_current: event.is_current,
          is_previous: event.is_previous,
          is_next: event.is_next,
          average_entry_score: event.average_entry_score,
          highest_score: event.highest_score,
          highest_scoring_entry: event.highest_scoring_entry,
          can_enter: event.can_enter,
          can_manage: event.can_manage,
          ranked_count: event.ranked_count,
          most_selected: event.most_selected,
          most_transferred_in: event.most_transferred_in,
          most_captained: event.most_captained,
          most_vice_captained: event.most_vice_captained,
          top_element: event.top_element,
          top_element_info: event.top_element_info,
          transfers_made: event.transfers_made,
          cup_leagues_created: event.cup_leagues_created,
          h2h_ko_matches_created: event.h2h_ko_matches_created,
          chip_plays: event.chip_plays,
          overrides: event.overrides,
          last_synced: new Date().toISOString()
        }
      }));
      stored += 1;
    } catch (err) {
      logger.error(`Failed to store event ${event.id}`, err);
      errors += 1;
    }
  }
  
  logger.info('Events storage complete', { stored, errors });
  logger.metric('events_stored', stored);
  return { stored, errors };
}

export async function handler(event) {
  const startTime = Date.now();
  
  logger.info('Starting bootstrap data ingestion');
  
  try {
    // Get current season
    const seasonId = await getSeasonId();
    logger.info('Got season_id', { season_id: seasonId });
    
    // Fetch bootstrap
    const bootstrap = await getBootstrap();
    
    // Store all static data
    const teamsResult = await storeTeams(bootstrap.teams, seasonId);
    const playersResult = await storePlayers(bootstrap.elements, seasonId);
    const etResult = await storeElementTypes(bootstrap.element_types, seasonId);
    const eventsResult = await storeEvents(bootstrap.events, seasonId);
    
    const duration = Date.now() - startTime;
    
    const summary = {
      teams: teamsResult.stored,
      players: playersResult.stored,
      element_types: etResult.stored,
      events: eventsResult.stored,
      errors: teamsResult.errors + playersResult.errors + etResult.errors + eventsResult.errors,
      duration_ms: duration
    };
    
    logger.info('Bootstrap ingestion complete', summary);
    logger.metric('bootstrap_duration_ms', duration);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Bootstrap data ingestion completed',
        summary,
        timestamp: new Date().toISOString()
      })
    };
    
  } catch (err) {
    logger.error('Bootstrap ingestion failed', err);
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
