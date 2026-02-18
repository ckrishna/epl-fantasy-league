import { getGWWinners, dynamodb } from '../utils/dynamodb.mjs';
import { callClaude } from '../utils/bedrock.mjs';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

async function getLatestGameweek() {
  try {
    const response = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
    const data = await response.json();
    const current = data.events.find(e => e.is_current);
    return current?.id || 26;
  } catch (err) {
    return 26;
  }
}

async function getPlayerDataForGW(gw, seasonId) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'player_event_stats',
      KeyConditionExpression: 'season_id = :sid AND begins_with(gameweek_player, :gw)',
      ExpressionAttributeValues: { ':sid': seasonId, ':gw': `${gw}#` }
    }));
    return result.Items || [];
  } catch (err) {
    console.error('Error fetching player data:', err);
    return [];
  }
}

async function getOurLeaguePicks(gw) {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_picks',
      FilterExpression: 'gameweek = :gw',
      ExpressionAttributeValues: { ':gw': gw }
    }));
    return result.Items || [];
  } catch (err) {
    console.error('Error fetching our picks:', err);
    return [];
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
    console.error('Failed to get season_id', err);
    throw err;
  }
}


async function callClaudeWithContext(question, leagueContext) {


const systemPrompt = `You are a Fantasy Premier League analyst analyzing captain picks from our league.

DATA STRUCTURE:
- our_league_picks: Array of {manager: "Manager Name", player: "Player Name", position: "Position", is_captain: true/false}
- These are ACTUAL FPL PLAYERS picked by our league MANAGERS
- When is_captain=true, that player was captained by that manager

Each player has:
- name, team_name, position, points, minutes, goals, assists
- ownership: global ownership percentage in FPL

KEY INSIGHT: A "differential" is a player with HIGH POINTS but LOW OWNERSHIP %.
TO FIND DIFFERENTIALS:
1. Look for players with high points (8+) AND low ownership (<10%)
2. Check if our league managers also picked them
3. If high points + low global ownership = differential

PLAYER DATA (GW${leagueContext.gameweek}):
${JSON.stringify(leagueContext.players_gw_data, null, 2)}

OUR LEAGUE MANAGER PICKS (GW${leagueContext.gameweek}):
${JSON.stringify(leagueContext.our_league_picks.slice(0, 20), null, 2)}

ANALYSIS RULES:
1. Find PLAYERS (not managers) where is_captain = true
2. Look up each captained PLAYER in the player data
3. Report PLAYER name + points scored + manager who captained them
4. Identify which FPL PLAYERS were the best captain choices

Example: "Virgil van Dijk captained by Michael Kojo Brown scored 17 points"
NOT: "Michael Kojo Brown captained Michael Kojo Brown"

GW WINS SUMMARY (Total wins by manager):
${JSON.stringify(leagueContext.winners_summary, null, 2)}
RECENT GW WINNERS (All ${leagueContext.gw_winners.length} gameweeks):
${JSON.stringify(leagueContext.gw_winners, null, 2)}
Answer the user's question using this data.`;


  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: question
      }
    ]
  };

  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });

  const command = new InvokeModelCommand({
    modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload)
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  
  return {
    response: responseBody.content[0].text,
    usage: responseBody.usage
  };
}

export async function handleGenBI(body, corsHeaders) {
  const { question } = body;
  
  if (!question) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing question' })
    };
  }

  try {
    const seasonId = await getSeasonId();
    const gw = await getLatestGameweek();
    const gwWinners = await getGWWinners();
// Transform gw_winners into cleaner format
const winnersByManager = {};
gwWinners.forEach(gw => {
  if (gw.winners && Array.isArray(gw.winners)) {
    gw.winners.forEach(winner => {
      const managerName = winner.manager_name || winner.M?.manager_name?.S;
      if (managerName) {
        winnersByManager[managerName] = (winnersByManager[managerName] || 0) + 1;
      }
    });
  }
});
    const playerData = await getPlayerDataForGW(gw, seasonId);
    const ourPicks = await getOurLeaguePicks(gw);

    const leagueContext = {
      gameweek: gw,
      gw_winners: gwWinners,
  winners_summary: winnersByManager,  // ← Add this
players_gw_data: playerData
  .sort((a, b) => {
    const bPoints = typeof b.points === 'object' ? parseInt(b.points.N) : parseInt(b.points);
    const aPoints = typeof a.points === 'object' ? parseInt(a.points.N) : parseInt(a.points);
    return bPoints - aPoints;
  })
  .slice(0, 50)
  .map(p => ({
    name: typeof p.name === 'object' ? p.name.S : p.name,
    team_name: typeof p.team_name === 'object' ? p.team_name.S : p.team_name,
    position: typeof p.position === 'object' ? p.position.S : p.position,
    points: typeof p.points === 'object' ? parseInt(p.points.N) : p.points,
    ownership: typeof p.selected_by_percent === 'object' ? p.selected_by_percent.S : p.selected_by_percent
  })),
      our_league_picks: ourPicks.map(pick => ({
        manager: pick.manager_name,
        player: pick.player_name,
        position: pick.position_player,
        is_captain: pick.is_captain
      }))
    };

    const result = await callClaudeWithContext(question, leagueContext);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        question,
        answer: result.response,
        usage: result.usage,
        timestamp: new Date().toISOString(),
        gameweek: gw
      })
    };

  } catch (err) {
    console.error('GenBI error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
}
