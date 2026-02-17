import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));

const SEASON = '2025/26';
const FPL_API = 'https://fantasy.premierleague.com/api';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function getLeagueData() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'gw-winners-cache'
  }));
  return result.Items || [];
}

async function getActiveGameweek() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`);
    const data = await response.json();
    return data.events.find(e => e.is_current)?.id || 26;
  } catch (err) {
    return 26;
  }
}

async function callClaudeWithContext(question, leagueContext) {
  const systemPrompt = `You are a Fantasy Premier League analyst. You have access to league data.
League context: ${JSON.stringify(leagueContext, null, 2)}

Answer the user's question based on this data.`;

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

export async function handler(event) {
  console.log('Event:', JSON.stringify(event));

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const path = event.path || event.rawPath || '';
    const queryParams = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    // ===== /stats/query (Claude GenBI) =====
    if (path.includes('/stats/query')) {
      const { question } = body;
      if (!question) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Missing question' })
        };
      }

      console.log('Fetching league context...');
      const leagueData = await getLeagueData();
      
      console.log('Calling Claude...');
      const result = await callClaudeWithContext(question, leagueData);
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          question,
          answer: result.response,
          usage: result.usage,
          timestamp: new Date().toISOString()
        })
      };
    }

    // ===== /standings =====
    if (path.includes('/standings')) {
      const gw = queryParams.gw ? parseInt(queryParams.gw) : 25;
      const activeGW = await getActiveGameweek();
      
      const result = await dynamodb.send(new ScanCommand({
        TableName: 'fpl_entry_gameweek',
        FilterExpression: 'gameweek = :gw',
        ExpressionAttributeValues: {
          ':gw': parseInt(gw)
        }
      }));

      const standings = (result.Items || [])
        .map(item => ({
          ...item,
          net_points: (item.points_this_week || 0) - (item.transfer_cost || 0)
        }))
        .sort((a, b) => b.net_points - a.net_points);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          gameweek: parseInt(gw),
          active_gameweek: activeGW,
          standings: standings,
          last_updated: standings[0]?.last_synced || null,
          timestamp: new Date().toISOString()
        })
      };
    }

    // ===== /winners =====
    if (path.includes('/winners')) {
      const result = await dynamodb.send(new ScanCommand({
        TableName: 'gw-winners-cache'
      }));

      const winners = (result.Items || [])
        .sort((a, b) => b.gameweek - a.gameweek)
        .map(w => ({
          gameweek: w.gameweek,
          winners: w.winners || [],
          winner_count: (w.winners || []).length,
          season: w.season
        }));

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          active_gameweek: 26,
          finished_gameweeks: winners,
          total_gameweeks_completed: winners.length,
          last_updated: winners[0]?.last_synced || null,
          timestamp: new Date().toISOString()
        })
      };
    }

    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Endpoint not found' }) };

  } catch (err) {
    console.error('Error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
}
