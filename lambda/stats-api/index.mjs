import { handleStandings } from './handlers/standings.mjs';
import { handleWinners } from './handlers/winners.mjs';
import { handleGenBI } from './handlers/genbi.mjs';
import { handleSeasons } from './handlers/seasons.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export async function handler(event) {
  console.log('Event:', JSON.stringify(event));

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const path = event.path || event.rawPath || '';
    const queryParams = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    if (path.includes('/stats/query')) {
      return await handleGenBI(body, corsHeaders);
    }
    
    if (path.includes('/standings')) {
      return await handleStandings(queryParams, corsHeaders);
    }
    
    if (path.includes('/winners')) {
      return await handleWinners(queryParams, corsHeaders);
    }

    if (path.includes('/seasons')) {
      return await handleSeasons(corsHeaders);
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
