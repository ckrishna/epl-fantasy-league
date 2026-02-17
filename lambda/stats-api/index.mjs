import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));

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
    const body = event.body ? JSON.parse(event.body) : {};

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
      
      console.log('Calling Claude with context...');
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

    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Not found' }) };

  } catch (err) {
    console.error('Error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
}
