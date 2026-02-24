import { getGWWinners, dynamodb } from '../utils/dynamodb.mjs';
import { callClaude } from '../utils/bedrock.mjs';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Fetches all teams for the current season to map IDs to actual names.
 * This prevents the AI from guessing team names based on its memory.
 */
async function getAllTeamsForSeason(seasonId) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'teams',
      KeyConditionExpression: 'season_id = :sid',
      ExpressionAttributeValues: { ':sid': seasonId }
    }));
    // Map team_id to name (e.g., { "14": "Man Utd", "13": "Man City" })
    return (result.Items || []).reduce((acc, team) => {
      const id = typeof team.team_id === 'object' ? team.team_id.N : team.team_id;
      const name = typeof team.name === 'object' ? team.name.S : team.name;
      acc[id] = name;
      return acc;
    }, {});
  } catch (err) {
    console.error('Error fetching team mapping:', err);
    return {};
  }
}

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


const systemPrompt = `
<role>
You are a deterministic FPL Data Analyst. Your output MUST be 100% grounded in the provided context. You are strictly forbidden from using your own memory of player transfers or team history.
</role>

<definitions>
- MANAGER FORM: Defined EXCLUSIVELY by the number of wins in the <recent_form_summary> (the last 5 weeks of data).
- SEASON LEADERS: Defined by the <total_season_summary>.
- CAPTAIN SCORE: (Player's GW points as listed) × 2.
</definitions>

<context>
  <current_gw>${leagueContext.gameweek}</current_gw>
  <recent_form_summary>${JSON.stringify(leagueContext.recent_form_summary)}</recent_form_summary>
  <total_season_summary>${JSON.stringify(leagueContext.total_season_summary)}</total_season_summary>
  <player_data>${JSON.stringify(leagueContext.players_gw_data)}</player_data>
  <manager_picks>${JSON.stringify(leagueContext.our_league_picks)}</manager_picks>
</context>

<instructions>
1. If asked about "Form": Rank managers by the count in <recent_form_summary>. Explain that "Form" considers only the last 5 gameweeks.
2. If asked about "Captains": 
   - Match the player name from <manager_picks> to their points in <player_data>.
   - YOU MUST SHOW THE MATH: "(Points) x 2 = Total". 
   - Never report a captain score higher than 60 for a single gameweek.
3. DATA INTEGRITY: Use only the 'team_name' provided in <player_data>. Do not assume Mbeumo is at Brentford if the data says "Man Utd".
</instructions>

Calculate results carefully using only the provided context and be concise.`;

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

/**
 * Enhanced GenBI Handler
 * Resolves mid-season transfers and calculates recent form logic.
 */
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

    // 1. Fetch all required data in parallel
    const [gwWinners, playerData, ourPicks, teamMap] = await Promise.all([
      getGWWinners(),
      getPlayerDataForGW(gw, seasonId),
      getOurLeaguePicks(gw),
      getAllTeamsForSeason(seasonId)
    ]);

    // 2. Calculate Total Season Wins
    const totalWinnersSummary = {};
    gwWinners.forEach(gwData => {
      (gwData.winners || []).forEach(winner => {
        const managerName = winner.manager_name || winner.M?.manager_name?.S;
        if (managerName) {
          totalWinnersSummary[managerName] = (totalWinnersSummary[managerName] || 0) + 1;
        }
      });
    });

    // 3. Calculate Recent Form (Last 5 Gameweeks)
    const recentFormSummary = {};
    const sortedGWs = [...gwWinners].sort((a, b) => b.gameweek - a.gameweek);
    const last5Weeks = sortedGWs.slice(0, 5);
    
    last5Weeks.forEach(gwData => {
      (gwData.winners || []).forEach(winner => {
        const managerName = winner.manager_name || winner.M?.manager_name?.S;
        if (managerName) {
          recentFormSummary[managerName] = (recentFormSummary[managerName] || 0) + 1;
        }
      });
    });

    // 4. Enrich Context with joined data and fixed types
    const leagueContext = {
      gameweek: gw,
      total_season_summary: totalWinnersSummary,
      recent_form_summary: recentFormSummary, 
      players_gw_data: playerData
        .sort((a, b) => {
          const bPts = typeof b.points === 'object' ? parseInt(b.points.N) : parseInt(b.points || 0);
          const aPts = typeof a.points === 'object' ? parseInt(a.points.N) : parseInt(a.points || 0);
          return bPts - aPts;
        })
        .slice(0, 50)
        .map(p => {
          const teamId = typeof p.team_id === 'object' ? p.team_id.N : p.team_id;
          return {
            name: typeof p.web_name === 'object' ? p.web_name.S : (p.web_name || p.name),
            // Resolve actual name from Teams table (Fixes Mbeumo at Brentford issue)
            team_name: teamMap[teamId] || "Unknown Team", 
            points: typeof p.points === 'object' ? parseInt(p.points.N) : parseInt(p.points || 0),
            ownership: typeof p.selected_by_percent === 'object' ? p.selected_by_percent.S : (p.selected_by_percent || "0.0%")
          };
        }),
      our_league_picks: ourPicks.map(pick => ({
        manager: pick.manager_name,
        player: pick.player_name,
        is_captain: pick.is_captain
      }))
    };

    // 5. Invoke Claude with refined context
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
    console.error('GenBI execution error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
}
