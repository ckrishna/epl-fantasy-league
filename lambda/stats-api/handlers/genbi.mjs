import {
  getGWWinners,
  getActiveGameweek,
  getCurrentSeasonInfo,
  getCurrentSeason,
  getAllSeasons,
  getLatestStoredGameweek,
  queryLeagueStandings,
  dynamodb
} from '../utils/dynamodb.mjs';
import { askClaude } from '../utils/bedrock.mjs';
import { selectRelevantFields } from '../utils/router.mjs';
import { checkBudget, recordUsage, markWarned, DAILY_BUDGET_USD } from '../utils/genbi-budget.mjs';
import { recordQueryLog, submitFeedback } from '../utils/genbi-log.mjs';
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

// Authoritative, FPL-sourced season totals, backfilled once via
// scripts/backfill-season-totals.mjs (reads each current player's history_past entry
// for a given past season -- accurate regardless of any gaps in our own weekly
// ingestion). Preferred over the live aggregation below whenever it's available for the
// requested season; only covers players still in FPL's current player pool (anyone who
// left the league since won't have a current element ID to look this up against).
async function getAuthoritativeSeasonTotals(seasonString) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'player_season_totals',
      KeyConditionExpression: 'season_string = :s',
      ExpressionAttributeValues: { ':s': seasonString }
    }));
    return result.Items || [];
  } catch (err) {
    console.error('Error fetching authoritative season totals:', err);
    return [];
  }
}

// Aggregates real season-long totals directly from player_event_stats (summing every
// gameweek's total_points per player), rather than trusting the `players` table's own
// total_points field -- that field is only ever as fresh as the last time fpl-bootstrap
// happened to run, and was confirmed stale for 2025/26 (last synced mid-February, well
// before the season's actual end). Queries the whole season_id partition (no gameweek
// filter), so it pages through DynamoDB's 1MB-per-response limit via LastEvaluatedKey.
//
// Used only as a fallback when no authoritative data exists for the season (see
// getAuthoritativeSeasonTotals above) -- this live aggregation can only ever be as
// complete as our own weekly ingestion, which has known gaps for some historical
// gameweeks.
async function getSeasonTotalsForPlayers(seasonId) {
  try {
    const totals = new Map(); // player_id -> { name, team_id, points, ownership, lastGw }
    let lastEvaluatedKey;

    do {
      const result = await dynamodb.send(new QueryCommand({
        TableName: 'player_event_stats',
        KeyConditionExpression: 'season_id = :sid',
        ExpressionAttributeValues: { ':sid': seasonId },
        ExclusiveStartKey: lastEvaluatedKey
      }));

      for (const row of result.Items || []) {
        const playerId = typeof row.player_id === 'object' ? row.player_id.N : row.player_id;
        const points = typeof row.total_points === 'object' ? parseInt(row.total_points.N) : parseInt(row.total_points || 0);
        const gw = typeof row.gameweek === 'object' ? parseInt(row.gameweek.N) : parseInt(row.gameweek || 0);
        const name = typeof row.name === 'object' ? row.name.S : row.name;
        const teamId = typeof row.team_id === 'object' ? row.team_id.N : row.team_id;
        const ownership = typeof row.selected_by_percent === 'object' ? row.selected_by_percent.S : row.selected_by_percent;

        const existing = totals.get(playerId);
        if (!existing) {
          totals.set(playerId, { points, lastGw: gw, name, team_id: teamId, ownership });
        } else {
          existing.points += points;
          // Keep the identity fields (name/team/ownership) from whichever gameweek row
          // is most recent -- a player's team or ownership % can change mid-season.
          if (gw >= existing.lastGw) {
            existing.lastGw = gw;
            existing.name = name;
            existing.team_id = teamId;
            existing.ownership = ownership;
          }
        }
      }

      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return Array.from(totals.values());
  } catch (err) {
    console.error('Error fetching season totals:', err);
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

// fpl_entry_picks rows carry only entry_id, never manager_name (confirmed against
// fpl-data-ingester's actual storePicks() write -- the item shape has no manager_name
// field at all). The pre-existing our_league_picks mapping read `pick.manager_name`
// directly, which was always undefined -- every captain-picks question this whole
// project has ever answered sent Claude a <manager_picks> array where every single
// "manager" field was undefined. No test caught it because every existing test either
// hand-built leagueContext directly (bypassing this mapping) or only checked that the
// fetch happened, never that the resulting values were correct. Found while building
// #39 Phase 2 (ownership aggregates), which needs the exact same entry_id -> name join.
//
// Scoped to a single gameweek (not the whole season, unlike getManagerSeasonAggregates)
// since this is only ever used for gameweek-scoped picks data -- cheaper than a
// season-wide scan for what's normally an ~11-row lookup.
async function getManagerNamesForGW(gw, season) {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek',
      FilterExpression: 'season = :s AND gameweek = :gw',
      ExpressionAttributeValues: { ':s': season, ':gw': gw }
    }));
    const nameByEntryId = new Map();
    for (const row of result.Items || []) {
      if (row.entry_id != null && row.manager_name) nameByEntryId.set(row.entry_id, row.manager_name);
    }
    return nameByEntryId;
  } catch (err) {
    console.error('Error fetching manager names for gameweek:', err);
    return new Map();
  }
}

// #39 Phase 1: manager-level season aggregates. Single scan of each table per request
// (not per-manager queries) -- both fpl_entry_gameweek and fpl_entry_picks carry a
// plain `season` attribute alongside their composite keys, so a season-scoped
// FilterExpression works the same way getLatestStoredGameweek already relies on.
//
// fpl_entry_picks has no manager_name field of its own (only entry_id), so identity is
// joined via a name map built from fpl_entry_gameweek's rows -- avoids a third query.
//
// Explicitly NOT covered here (and the prompt says so): WHICH players were transferred
// in/out, and their subsequent performance. fpl_entry_gameweek only has aggregate
// transfers_made/transfer_cost per gameweek, not player-level transfer history, so
// "who made the most transfers" is answerable but "who made the BEST transfers" still
// isn't -- that would need a real transfer-log table (out of scope, not what exists).
async function getManagerSeasonAggregates(season) {
  try {
    const [gwResult, picksResult] = await Promise.all([
      dynamodb.send(new ScanCommand({
        TableName: 'fpl_entry_gameweek',
        FilterExpression: 'season = :s',
        ExpressionAttributeValues: { ':s': season }
      })),
      dynamodb.send(new ScanCommand({
        TableName: 'fpl_entry_picks',
        FilterExpression: 'season = :s',
        ExpressionAttributeValues: { ':s': season }
      }))
    ]);

    const gwRows = gwResult.Items || [];
    const pickRows = picksResult.Items || [];

    const managers = new Map();
    function getManager(name) {
      if (!managers.has(name)) {
        managers.set(name, {
          manager: name,
          gameweeks_played: 0,
          highest_gw_score: -Infinity,
          lowest_gw_score: Infinity,
          season_total_points: 0,
          total_transfers_made: 0,
          total_transfer_hits: 0,
          chips_used: [],
          bench_points_wasted: 0,
          captain_points_season: 0
        });
      }
      return managers.get(name);
    }

    const nameByEntryId = new Map();

    for (const row of gwRows) {
      const name = row.manager_name;
      if (!name) continue;
      if (row.entry_id != null) nameByEntryId.set(row.entry_id, name);

      const m = getManager(name);
      const ptsThisWeek = Number(row.points_this_week || 0);
      m.gameweeks_played += 1;
      m.highest_gw_score = Math.max(m.highest_gw_score, ptsThisWeek);
      m.lowest_gw_score = Math.min(m.lowest_gw_score, ptsThisWeek);
      m.total_transfers_made += Number(row.transfers_made || 0);
      m.total_transfer_hits += Number(row.transfer_cost || 0);
      if (row.active_chip) {
        m.chips_used.push({ chip: row.active_chip, gameweek: row.gameweek });
      }
      // points_total is cumulative as-of that gameweek -- the highest value seen across
      // all rows for a manager is their true season total, same idea as taking the last
      // gameweek's running total rather than summing every row (which would double-count).
      const total = Number(row.points_total || 0);
      if (total > m.season_total_points) m.season_total_points = total;
    }

    for (const row of pickRows) {
      const name = nameByEntryId.get(row.entry_id);
      if (!name) continue;
      const m = getManager(name);
      const pts = Number(row.points || 0);
      if (row.is_bench) m.bench_points_wasted += pts;
      if (row.is_captain) m.captain_points_season += pts;
    }

    return Array.from(managers.values()).map((m) => ({
      manager: m.manager,
      gameweeks_played: m.gameweeks_played,
      highest_gw_score: m.gameweeks_played > 0 ? m.highest_gw_score : 0,
      lowest_gw_score: m.gameweeks_played > 0 ? m.lowest_gw_score : 0,
      average_points_per_gw: m.gameweeks_played > 0
        ? Math.round((m.season_total_points / m.gameweeks_played) * 10) / 10
        : 0,
      total_transfers_made: m.total_transfers_made,
      total_transfer_hits: m.total_transfer_hits,
      chips_used: m.chips_used,
      bench_points_wasted: m.bench_points_wasted,
      captain_points_season: m.captain_points_season
    }));
  } catch (err) {
    console.error('Error computing manager season aggregates:', err);
    return [];
  }
}

// Current and longest GW-win streak per manager, derived from the same gw-winners-cache
// data total_season_summary/recent_form_summary already walk -- no extra fetch needed,
// just a different reduction over gwWinners. This is what issue #39 flagged as
// impossible to answer ("who won the most consecutive gameweeks") since only win
// *counts* existed, never streaks.
function computeWinStreaks(gwWinners) {
  const sorted = [...gwWinners].sort((a, b) => a.gameweek - b.gameweek);

  const managerNames = new Set();
  sorted.forEach((gwData) => (gwData.winners || []).forEach((w) => {
    const name = w.manager_name || w.M?.manager_name?.S;
    if (name) managerNames.add(name);
  }));

  const streaks = new Map();
  for (const name of managerNames) streaks.set(name, { current: 0, longest: 0 });

  for (const gwData of sorted) {
    const winnerNames = new Set(
      (gwData.winners || [])
        .map((w) => w.manager_name || w.M?.manager_name?.S)
        .filter(Boolean)
    );
    for (const name of managerNames) {
      const s = streaks.get(name);
      if (winnerNames.has(name)) {
        s.current += 1;
        s.longest = Math.max(s.longest, s.current);
      } else {
        s.current = 0;
      }
    }
  }

  const result = {};
  for (const [name, s] of streaks) {
    result[name] = { current_win_streak: s.current, longest_win_streak: s.longest };
  }
  return result;
}

// #39 Phase 2: ownership aggregates -- most-owned player and differentials (owned by
// exactly one manager), for the resolved gameweek. Pure function over already-fetched
// picks + the entry_id -> manager_name map (same data getOurLeaguePicks/
// getManagerNamesForGW already fetch for <manager_picks>, no extra query).
//
// "Differential" here means "owned by exactly one manager in OUR league", not FPL's
// global ownership -- this only ever sees our own league's squads, never the wider FPL
// player base, and the prompt says so explicitly (see bedrock.mjs instruction 8).
function computeOwnershipAggregates(picks, nameByEntryId) {
  const byPlayer = new Map();

  for (const pick of picks) {
    const managerName = nameByEntryId.get(pick.entry_id);
    const playerName = pick.player_name;
    if (!managerName || !playerName) continue;

    if (!byPlayer.has(playerName)) {
      byPlayer.set(playerName, {
        player: playerName,
        owners: new Set(),
        points_this_gw: Number(pick.points || 0)
      });
    }
    byPlayer.get(playerName).owners.add(managerName);
  }

  const players = Array.from(byPlayer.values()).map((p) => ({
    player: p.player,
    ownership_count: p.owners.size,
    owned_by: Array.from(p.owners),
    points_this_gw: p.points_this_gw
  }));

  const mostOwned = players.length > 0
    ? players.slice().sort((a, b) => b.ownership_count - a.ownership_count)[0]
    : null;

  const differentials = players
    .filter((p) => p.ownership_count === 1)
    .sort((a, b) => b.points_this_gw - a.points_this_gw)
    .slice(0, 20);

  return { most_owned_player: mostOwned, differentials };
}

// GenBI never actually had access to the real league table (total points + rank) --
// only win *counts* (see total_season_summary below). fpl_league_standings is the same
// table handleStandings reads for the dashboard's own Standings page, so this reuses
// queryLeagueStandings() rather than re-deriving anything. Mirrors handleStandings'
// walk-back-a-gameweek behavior: fpl_league_standings has had gaps independent of
// player_event_stats/fpl_entry_gameweek (e.g. the GW26 outage in DATA_MODEL.md), so the
// gameweek genbi.mjs already resolved for player data isn't guaranteed to have a
// standings row.
async function getCurrentStandings(gw, season) {
  try {
    let targetGw = gw;
    let standings = await queryLeagueStandings(targetGw, season);
    while ((!standings || standings.length === 0) && targetGw > 1) {
      targetGw -= 1;
      standings = await queryLeagueStandings(targetGw, season);
    }
    return (standings || [])
      .slice()
      .sort((a, b) => (b.total_points || 0) - (a.total_points || 0))
      .map((row, i) => ({
        rank: i + 1,
        manager: row.manager_name,
        team_name: row.team_name,
        total_points: row.total_points,
        points_this_week: row.points_this_week,
        gameweek: targetGw
      }));
  } catch (err) {
    console.error('Error fetching current standings:', err);
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

    // Deterministic (non-model) router: decides which of the 6 context fields this
    // question actually needs, so we don't fetch/send all of them on every question
    // regardless of relevance. Falls back to fetching everything when the question
    // doesn't clearly match anything -- see utils/router.mjs for the full rationale.
    const fields = selectRelevantFields(question);
    const needsTeamMap = fields.playerGwData || fields.seasonTotals;
    // managerStats needs gwWinners too -- win streaks are derived from the same
    // per-gameweek winners list total_season_summary/recent_form_summary already walk.
    const needsGwWinners = fields.seasonWins || fields.recentForm || fields.managerStats;
    // Both manager_picks (captain math) and ownership_aggregates (#39 Phase 2) need the
    // entry_id -> manager_name join, since fpl_entry_picks rows never carry a name of
    // their own -- see getManagerNamesForGW's comment for how this was discovered.
    const needsManagerNames = fields.managerPicks || fields.ownership;

    // Check for authoritative (FPL-sourced) season totals first -- cheap lookup. Only
    // fall back to the expensive full-season player_event_stats scan (below) if nothing
    // has been backfilled for this season yet. Skipped entirely if this question isn't
    // about season-long player totals at all.
    const authoritativeSeasonTotals = fields.seasonTotals ? await getAuthoritativeSeasonTotals(season) : [];

    // 1. Fetch only what the router decided is relevant, in parallel
    const [gwWinners, playerData, ourPicks, teamMap, seasonTotals, currentStandings, managerSeasonAggregates, managerNamesForGW] = await Promise.all([
      needsGwWinners ? getGWWinners(season) : Promise.resolve([]),
      fields.playerGwData ? getPlayerDataForGW(gw, seasonId) : Promise.resolve([]),
      (fields.managerPicks || fields.ownership) ? getOurLeaguePicks(gw) : Promise.resolve([]),
      needsTeamMap ? getAllTeamsForSeason(seasonId) : Promise.resolve({}),
      fields.seasonTotals
        ? (authoritativeSeasonTotals.length > 0 ? Promise.resolve([]) : getSeasonTotalsForPlayers(seasonId))
        : Promise.resolve([]),
      fields.standings ? getCurrentStandings(gw, season) : Promise.resolve([]),
      fields.managerStats ? getManagerSeasonAggregates(season) : Promise.resolve([]),
      needsManagerNames ? getManagerNamesForGW(gw, season) : Promise.resolve(new Map())
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

    // 3b. Merge win streaks (derived from gwWinners, no extra fetch) into the season
    // aggregates fetched above -- only when managerStats was actually requested, since
    // computeWinStreaks is wasted work otherwise and gwWinners may be empty.
    const winStreaks = fields.managerStats ? computeWinStreaks(gwWinners) : {};
    const managerSeasonStats = managerSeasonAggregates.map((m) => ({
      ...m,
      current_win_streak: winStreaks[m.manager]?.current_win_streak ?? 0,
      longest_win_streak: winStreaks[m.manager]?.longest_win_streak ?? 0
    }));

    // 4. Enrich Context with joined data and fixed types
    const leagueContext = {
      gameweek: gw,
      // The actual points table + rank -- distinct from total_season_summary below,
      // which is only win *counts*. This was never wired in before; GenBI had no way
      // to answer "what are the standings" / "who's leading" / "what's my rank" at all.
      current_standings: currentStandings,
      total_season_summary: totalWinnersSummary,
      recent_form_summary: recentFormSummary,
      players_gw_data: playerData
        .sort((a, b) => {
          // player_event_stats rows store the score in `total_points` -- there is no
          // `points` field on this table at all (confirmed against a live row). Reading
          // `points` silently evaluated to 0 for every player, which both faked every
          // player's score as 0 in Claude's context AND made this "sort by points" step
          // a no-op (0 vs 0), so the "top 50" slice below wasn't actually top anything.
          const bPts = typeof b.total_points === 'object' ? parseInt(b.total_points.N) : parseInt(b.total_points || 0);
          const aPts = typeof a.total_points === 'object' ? parseInt(a.total_points.N) : parseInt(a.total_points || 0);
          return bPts - aPts;
        })
        .slice(0, 50)
        .map(p => {
          const teamId = typeof p.team_id === 'object' ? p.team_id.N : p.team_id;
          return {
            name: typeof p.name === 'object' ? p.name.S : p.name,
            // Resolve actual name from Teams table (Fixes Mbeumo at Brentford issue)
            team_name: teamMap[teamId] || "Unknown Team",
            points: typeof p.total_points === 'object' ? parseInt(p.total_points.N) : parseInt(p.total_points || 0),
            // FPL's own per-PLAYER rolling form score (fpl-global-stats-weekly already
            // writes this to player_event_stats -- it just never got read here). Not to
            // be confused with recent_form_summary above, which is a per-MANAGER
            // win-streak count -- two different things that happen to both be called
            // "form". See bedrock.mjs's PLAYER FORM vs MANAGER FORM definitions.
            form: typeof p.form === 'object' ? parseFloat(p.form.N) : parseFloat(p.form || 0),
            ownership: typeof p.selected_by_percent === 'object' ? p.selected_by_percent.S : (p.selected_by_percent || "0.0%")
          };
        }),
      // Joined via managerNamesForGW (entry_id -> manager_name), NOT pick.manager_name --
      // that field never existed on fpl_entry_picks rows (see getManagerNamesForGW's
      // comment). Every captain-picks answer before this fix silently sent Claude
      // `manager: undefined` for every single pick.
      our_league_picks: ourPicks.map(pick => ({
        manager: managerNamesForGW.get(pick.entry_id) || 'Unknown',
        player: pick.player_name,
        is_captain: pick.is_captain,
        // fpl_entry_picks.points is a plain number (same table/field getManagerSeasonAggregates
        // already reads with Number(row.points || 0), no DynamoDB-JSON wrapping to unwrap here).
        points: Number(pick.points || 0)
      })),
      // Real season-long totals -- use this (not players_gw_data, which is a single
      // gameweek) for any "entire season" / "this season" scoring question. Prefers
      // FPL's own authoritative record when we have it backfilled for this season;
      // falls back to our own live aggregation (which can only be as complete as our
      // weekly ingestion) otherwise.
      season_totals: (
        authoritativeSeasonTotals.length > 0
          ? authoritativeSeasonTotals.map((t) => ({
              name: t.player_name,
              team_name: t.team_name || 'Unknown Team',
              points: t.total_points,
              ownership: null
            }))
          : seasonTotals.map((p) => ({
              name: p.name,
              team_name: teamMap[p.team_id] || 'Unknown Team',
              points: p.points,
              ownership: p.ownership || '0.0%'
            }))
      )
        .sort((a, b) => b.points - a.points)
        .slice(0, 50),
      // #39 Phase 1: per-manager season aggregates -- streaks, high/low single-GW
      // score, season average, transfer activity, chips, bench points wasted, season
      // captaincy points. See getManagerSeasonAggregates for exactly what is and isn't
      // covered (notably: transfer *counts*, not which players were transferred).
      manager_season_stats: managerSeasonStats,
      // #39 Phase 2: most-owned player and differentials (owned by exactly one manager)
      // for the resolved gameweek, scoped to OUR league's squads only -- never FPL's
      // global ownership. Only computed when actually asked for (fields.ownership) or
      // as a side benefit when manager_picks was already fetched anyway.
      ownership_aggregates: (fields.managerPicks || fields.ownership)
        ? computeOwnershipAggregates(ourPicks, managerNamesForGW)
        : { most_owned_player: null, differentials: [] }
    };

    // 5. Invoke Claude with refined context
    const claudeStartTime = Date.now();
    const result = await askClaude(question, leagueContext);
    const durationMs = Date.now() - claudeStartTime;

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

    // 7. Structured Q&A log: every answered question, which fields the router selected
    // for it, tokens/cost/duration, and a query_id the frontend can hold onto for the
    // upcoming thumbs-up/down feature. See utils/genbi-log.mjs for the row shape and
    // why this is scoped to the successful path only.
    const queryId = await recordQueryLog({
      question,
      season,
      gameweek: gw,
      fieldsSelected: fields,
      answer: result.response,
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0,
      costUsd,
      durationMs
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        question,
        answer: result.response,
        usage: result.usage,
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
        gameweek: gw,
        query_id: queryId
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

const VALID_FEEDBACK_VALUES = new Set(['up', 'down']);

/**
 * Attaches thumbs-up/down feedback to a previously answered question, referenced by
 * the query_id handleGenBI returned in its response. Builds on the genbi-query-log
 * table added for structured Q&A logging -- feedback only means anything once there's
 * a logged question to attach it to.
 */
export async function handleGenBIFeedback(body, corsHeaders) {
  const { query_id: queryId, feedback } = body;

  if (!queryId || typeof queryId !== 'string') {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing query_id' })
    };
  }

  if (!VALID_FEEDBACK_VALUES.has(feedback)) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: `feedback must be one of: ${[...VALID_FEEDBACK_VALUES].join(', ')}` })
    };
  }

  const result = await submitFeedback({ queryId, feedback });

  if (!result.success) {
    return {
      statusCode: result.notFound ? 404 : 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: result.notFound
          ? `Unknown query_id: ${queryId}`
          : 'Failed to record feedback'
      })
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ success: true, query_id: queryId, feedback })
  };
}
