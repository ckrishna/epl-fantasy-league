import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));

export async function queryLeagueStandings(gw) {
  const result = await dynamodb.send(new QueryCommand({
    TableName: 'fpl_league_standings',
    KeyConditionExpression: 'season_event = :se',
    ExpressionAttributeValues: { ':se': `2025/26#${gw}` }
  }));
  return result.Items || [];
}

export async function getGWWinners() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'gw-winners-cache'
  }));
  return result.Items || [];
}

export async function getActiveGameweek() {
  try {
    const response = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
    const data = await response.json();
    return data.events.find(e => e.is_current)?.id || 26;
  } catch (err) {
    return 26;
  }
}
