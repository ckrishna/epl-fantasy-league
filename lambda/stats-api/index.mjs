import { handleStandings } from './handlers/standings.mjs';
import { handleWinners } from './handlers/winners.mjs';
import { handleGenBI, handleGenBIFeedback } from './handlers/genbi.mjs';
import { handleSeasons } from './handlers/seasons.mjs';
import { handleFeedbackSubmit } from './handlers/feedback.mjs';

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

    if (path.includes('/stats/feedback')) {
      return await handleGenBIFeedback(body, corsHeaders);
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

    // Help page's "send feedback" form -- unrelated to /stats/feedback above (GenBI's
    // thumbs-up/down), a plain free-text message instead. Named /app-feedback rather
    // than the shorter /feedback specifically so it can never accidentally match as a
    // substring of /stats/feedback (or vice versa) if these checks are ever reordered.
    if (path.includes('/app-feedback')) {
      const sourceIp = event.requestContext?.identity?.sourceIp
        || event.requestContext?.http?.sourceIp
        || null;
      return await handleFeedbackSubmit(body, sourceIp, corsHeaders);
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
