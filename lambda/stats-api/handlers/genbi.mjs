import {
  getGWWinners,
  getActiveGameweek,
  getCurrentSeasonInfo,
  getCurrentSeason,
  getAllSeasons,
  getLatestStoredGameweek,
  dynamodb
} from '../utils/dynamodb.mjs';
import { askClaude } from '../utils/bedrock.mjs';
import { checkBudget, recordUsage, markWarned, DAILY_BUDGET_USD } from '../utils/genbi-budget.mjs';
import { sendBudgetWarningEmail } from '../utils/notify.mjs';
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

// Mirrors the historical-season pattern already used by handleStandings/handleWinners:
// a requested season that isn't the current one must never touch live FPL data (that
// reflects today's real season, not the one being looked back at), and must resolve
// against that season's own numeric season_id (reference tables like teams/
// player_event_stats are keyed by season_id, not season_string).
async function resolveSeasonContext(requestedSeason) {
  const currentSeason = await getCurrentSeason();
  const targetSeason = requestedSeason || currentSeason;
  const isHistorical = targetSeason !== currentSeason;

  let seasonId;
  if (isHistorical) {
    const allSeasons = await getAllSeasons();
    const match = allSeasons.find((s) => s.season_string === targetSeason);
    if (!match) {
      throw new Error(`Unknown season: ${targetSeason}`);
    }
    seasonId = match.season_id;
  } else {
    ({ seasonId } = await getCurrentSeasonInfo());
  }

  const gw = isHistorical
    ? await getLatestStoredGameweek(targetSeason)
    : await getActiveGameweek();

  return { season: targetSeason, seasonId, gw };
}

/**
 * Enhanced GenBI Handler
 * Resolves mid-season transfers and calculates recent form logic.
 */
export async function handleGenBI(body, corsHeaders) {
  const { question, season: requestedSeason } = body;
  
  if (!question) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing question' })
    };
  }

  try {
    // Cost guardrail: check today's Bedrock spend *before* doing any of the (also
    // costly, though free in dollar terms) data-fetching work below, and before ever
    // calling Bedrock itself. A blocked request costs nothing.
    const budget = await checkBudget();
    if (budget.overBudget) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          question,
          answer: `GenBI's daily budget ($${DAILY_BUDGET_USD.toFixed(2)}) has been reached for today. ` +
            `It resets at midnight UTC -- try again then.`,
          usage: null,
          timestamp: new Date().toISOString(),
          budget_exceeded: true
        })
      };
    }

    const { season, seasonId, gw } = await resolveSeasonContext(requestedSeason);

    // 1. Fetch all required data in parallel
    const [gwWinners, playerData, ourPicks, teamMap] = await Promise.all([
      getGWWinners(season),
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
    const result = await askClaude(question, leagueContext);

    // 6. Record the real cost of this call against today's budget, and warn (once per
    // day) if it just crossed the threshold. A notification failure here shouldn't fail
    // the whole request -- the manager still gets their answer.
    const costUsd = await recordUsage({
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0
    });
    if (budget.shouldWarn) {
      try {
        await sendBudgetWarningEmail({ costSoFar: budget.costSoFar + costUsd, limit: DAILY_BUDGET_USD });
        await markWarned();
      } catch (notifyErr) {
        console.error('Failed to send GenBI budget warning email', notifyErr);
      }
    }

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
