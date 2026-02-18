import { getGWWinners, dynamodb } from '../utils/dynamodb.mjs';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { callClaude } from '../utils/bedrock.mjs';

const SEASON = '2025/26';

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

async function getPlayerDataForGW(gw) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'fpl_gameweek_data',
      KeyConditionExpression: 'season_event = :se',
      ExpressionAttributeValues: { ':se': `${SEASON}#${gw}` }
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

async function callClaudeWithContext(question, leagueContext) {
  const systemPrompt = `You are a Fantasy Premier League analyst.

KEY INSIGHT: A "differential" is a player with HIGH POINTS but LOW OWNERSHIP %.

PLAYER DATA (GW${leagueContext.gameweek}):
${JSON.stringify(leagueContext.players_gw_data, null, 2)}

Each player has:
- name, team, position, points, minutes, goals, assists
- ownership: global ownership percentage in FPL

OUR LEAGUE PICKS (GW${leagueContext.gameweek}):
${JSON.stringify(leagueContext.our_league_picks.slice(0, 15), null, 2)}

TO FIND DIFFERENTIALS:
1. Look for players with high points (8+) AND low ownership (<10%)
2. Check if our league managers also picked them
3. If high points + low global ownership = differential

RECENT GW WINNERS:
${JSON.stringify(leagueContext.gw_winners.slice(0, 3), null, 2)}

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
    const gw = await getLatestGameweek();
    const gwWinners = await getGWWinners();
    const playerData = await getPlayerDataForGW(gw);
    const ourPicks = await getOurLeaguePicks(gw);

    const leagueContext = {
      gameweek: gw,
      gw_winners: gwWinners.slice(0, 5),
      players_gw_data: playerData
        .sort((a, b) => b.points - a.points)
        .slice(0, 50)
        .map(p => ({
          name: p.name,
          team: p.team_name,
          position: p.position,
          points: p.points,
          ownership: p.selected_by_percent
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
