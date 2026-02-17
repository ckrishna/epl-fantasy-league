// lambda/fpl-data-ingester/index.mjs
// Deploy: 
//   zip -r lambda.zip .
//   aws lambda create-function --function-name fpl-data-ingester --runtime nodejs18.x --role [IAM_ROLE] --handler index.handler --zip-file fileb://lambda.zip --timeout 60 --memory-size 256

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import https from 'https';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const LEAGUE_ID = 212889;
const SEASON = '2025/26';

// Fetch from FPL API
function fetchFPL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Parse error on ${url}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Batch write with 25-item limit
async function batchWrite(tableName, items) {
  if (items.length === 0) {
    console.log(`⏭️  No items for ${tableName}`);
    return;
  }
  
  const batches = [];
  for (let i = 0; i < items.length; i += 25) {
    batches.push(items.slice(i, i + 25));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const RequestItems = {
      [tableName]: batch.map(item => ({ PutRequest: { Item: item } }))
    };
    
    await dynamodb.send(new BatchWriteCommand({ RequestItems }));
    console.log(`  ✅ Batch ${batchIdx + 1}/${batches.length} written to ${tableName}`);
  }
}

export async function handler(event) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const pullId = timestamp.replace(/[:\-.]/g, '').slice(0, 13);
  
  console.log('🚀 FPL Data Ingestion Started');
  console.log(`   Timestamp: ${timestamp}`);
  console.log(`   Pull ID: ${pullId}`);

  const recordsProcessed = {
    players: 0,
    standings: 0,
    fixtures: 0
  };
  
  const errors = [];

  try {
    // 1. Fetch bootstrap
    console.log('\n📥 Step 1: Fetching bootstrap-static...');
    const bootstrap = await fetchFPL('https://fantasy.premierleague.com/api/bootstrap-static/');
    console.log(`   ✅ Got ${bootstrap.elements.length} players, ${bootstrap.teams.length} teams, ${bootstrap.events.length} gameweeks`);

    // Get current finished gameweek
    const finishedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
    const maxGW = Math.max(...finishedGWs);
    console.log(`   ✅ Latest finished GW: ${maxGW}`);

    // 2. Fetch league standings
    console.log('\n📥 Step 2: Fetching league standings...');
    const leagueRes = await fetchFPL(
      `https://fantasy.premierleague.com/api/leagues-classic/${LEAGUE_ID}/standings/?page_standings=1`
    );
    const standings = leagueRes.standings.results;
    console.log(`   ✅ Got ${standings.length} league members`);

    // 3. Fetch live data for current GW
    console.log(`\n📥 Step 3: Fetching live data for GW ${maxGW}...`);
    const liveData = await fetchFPL(
      `https://fantasy.premierleague.com/api/event/${maxGW}/live/`
    );
    console.log(`   ✅ Got ${liveData.elements.length} player entries`);

    // Prepare gameweek player data
    console.log('\n⚙️  Processing player gameweek data...');
    const gameweekItems = liveData.elements.map(player => {
      const playerData = bootstrap.elements.find(e => e.id === player.id);
      const teamData = bootstrap.teams.find(t => t.id === playerData.team);
      const elementType = bootstrap.element_types.find(et => et.id === playerData.element_type);
      
      return {
        season_event: `${SEASON}#${maxGW}`,
        element_id: player.id,
        name: playerData.web_name,
        team_id: playerData.team,
        team_name: teamData.name,
        position: elementType.singular_name,
        points: player.stats.total_points || 0,
        minutes: player.stats.minutes || 0,
        goals: player.stats.goals_scored || 0,
        assists: player.stats.assists || 0,
        clean_sheets: player.stats.clean_sheets || 0,
        yellow_cards: player.stats.yellow_cards || 0,
        red_cards: player.stats.red_cards || 0,
        bonus: player.stats.bonus || 0,
        bps: player.stats.bps || 0,
        form: parseFloat(playerData.form) || 0,
        value: playerData.now_cost || 0,
        selected_by_percent: parseFloat(playerData.selected_by_percent) || 0
      };
    });

    await batchWrite('fpl_gameweek_data', gameweekItems);
    recordsProcessed.players = gameweekItems.length;

    // Prepare standings data
    console.log('\n⚙️  Processing standings data...');
    const standingItems = standings.map((player, idx) => ({
      season_event: `${SEASON}#${maxGW}`,
      manager_id: player.entry,
      manager_name: player.player_name,
      team_name: player.entry_name,
      rank: idx + 1,
      total_points: player.total,
      points_this_week: player.event_total || 0,
      earnings: 0.0 // Will be calculated separately
    }));

    await batchWrite('fpl_league_standings', standingItems);
    recordsProcessed.standings = standingItems.length;

    // Fetch and store fixtures
    console.log('\n📥 Step 4: Fetching fixtures...');
    const fixturesRes = await fetchFPL('https://fantasy.premierleague.com/api/fixtures/');
    const fixturesThisGW = fixturesRes.filter(f => f.event === maxGW);
    
    console.log(`   ✅ Got ${fixturesThisGW.length} fixtures for GW ${maxGW}`);

    console.log('\n⚙️  Processing fixture data...');
    const fixtureItems = fixturesThisGW.map(f => {
      const homeTeam = bootstrap.teams.find(t => t.id === f.team_h);
      const awayTeam = bootstrap.teams.find(t => t.id === f.team_a);
      
      return {
        season_fixture: `${SEASON}#${f.id}`,
        event: f.event,
        fixture_id: f.id,
        kickoff_time: f.kickoff_time || null,
        status: f.finished ? 'FINISHED' : (f.started ? 'LIVE' : 'SCHEDULED'),
        minutes: f.minutes || 0,
        team_h: f.team_h,
        team_h_name: homeTeam?.name || 'Unknown',
        team_h_score: f.team_h_score || null,
        team_a: f.team_a,
        team_a_name: awayTeam?.name || 'Unknown',
        team_a_score: f.team_a_score || null
      };
    });

    await batchWrite('fpl_fixture_data', fixtureItems);
    recordsProcessed.fixtures = fixtureItems.length;

    // Log pull completion
    console.log('\n📝 Logging pull completion...');
    const duration = Date.now() - startTime;
    const logItem = {
      pull_logs: 'pull_logs',
      timestamp: timestamp,
      pull_id: pullId,
      status: 'SUCCESS',
      season: SEASON,
      max_gameweek: maxGW,
      records_processed: recordsProcessed,
      api_calls_made: 4,
      duration_ms: duration,
      errors: errors.length > 0 ? errors : undefined,
      next_run: new Date(Date.now() + 86400000).toISOString()
    };

    await dynamodb.send(new BatchWriteCommand({
      RequestItems: {
        data_pull_logs: [{ PutRequest: { Item: logItem } }]
      }
    }));

    console.log('\n✅ PULL SUCCESSFUL!');
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Players: ${recordsProcessed.players}`);
    console.log(`   Standings: ${recordsProcessed.standings}`);
    console.log(`   Fixtures: ${recordsProcessed.fixtures}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'SUCCESS',
        pullId: pullId,
        timestamp: timestamp,
        gameweek: maxGW,
        recordsProcessed: recordsProcessed,
        duration_ms: duration
      })
    };

  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    errors.push(err.message);

    // Log error
    try {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          data_pull_logs: [{
            PutRequest: {
              Item: {
                pull_logs: 'pull_logs',
                timestamp: timestamp,
                pull_id: pullId,
                status: 'ERROR',
                error_message: err.message,
                duration_ms: Date.now() - startTime
              }
            }
          }]
        }
      }));
    } catch (logErr) {
      console.error('Failed to log error:', logErr);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'ERROR',
        pullId: pullId,
        error: err.message,
        duration_ms: Date.now() - startTime
      })
    };
  }
}

